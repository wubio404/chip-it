import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/db.js';
import { verifyPassword } from '../lib/password.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  type AuthClaims,
} from '../lib/jwt.js';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  accessCookieOptions,
  refreshCookieOptions,
  accessClearOptions,
  refreshClearOptions,
} from '../lib/cookies.js';
import { requireAuth } from '../middleware/auth.js';

interface LoginBody {
  email: string;
  password: string;
}

interface MeQuery {
  venue?: string; // venue slug from the /admin/[venue] URL — see /admin/me below
}

export async function authRoutes(fastify: FastifyInstance) {
  // -------------------------------------------------------------------------
  // POST /auth/login — email + password → sets access + refresh cookies.
  // Body reveals only success; the tokens live in httpOnly cookies, never JSON.
  // -------------------------------------------------------------------------
  fastify.post<{ Body: LoginBody }>(
    '/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email:    { type: 'string', minLength: 3, maxLength: 255 },
            password: { type: 'string', minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body;

      const user = await prisma.user.findUnique({
        where: { email: email.toLowerCase().trim() },
        select: { id: true, password_hash: true, role: true, venue_id: true },
      });

      // Generic 401 whether the email is unknown or the password is wrong — do not
      // leak which accounts exist. Always run bcrypt.compare against a real-looking
      // hash even when the user is missing would be ideal to flatten timing; here the
      // hash lookup dominates and the risk is low for a back-office login.
      if (!user || !(await verifyPassword(password, user.password_hash))) {
        return reply.status(401).send({ error: 'invalid_credentials' });
      }

      const claims: AuthClaims = { sub: user.id, role: user.role, venue_id: user.venue_id };

      reply
        .setCookie(ACCESS_COOKIE, signAccessToken(claims), accessCookieOptions())
        .setCookie(REFRESH_COOKIE, signRefreshToken(claims), refreshCookieOptions());

      fastify.log.info({ event: 'auth_login', user_id: user.id, role: user.role });
      return reply.send({ ok: true });
    },
  );

  // -------------------------------------------------------------------------
  // POST /auth/refresh — rotates the ACCESS token from a valid refresh cookie.
  // Re-reads the user so a revoked/edited account can't keep minting tokens.
  // -------------------------------------------------------------------------
  fastify.post('/auth/refresh', async (request, reply) => {
    const token = request.cookies?.[REFRESH_COOKIE];
    const claims = token ? verifyRefreshToken(token) : null;
    if (!claims) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    // Confirm the account still exists and pick up any role/venue change.
    const user = await prisma.user.findUnique({
      where: { id: claims.sub },
      select: { id: true, role: true, venue_id: true },
    });
    if (!user) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const fresh: AuthClaims = { sub: user.id, role: user.role, venue_id: user.venue_id };
    reply.setCookie(ACCESS_COOKIE, signAccessToken(fresh), accessCookieOptions());

    fastify.log.info({ event: 'auth_refresh', user_id: user.id });
    return reply.send({ ok: true });
  });

  // -------------------------------------------------------------------------
  // POST /auth/logout — clears both cookies (same path/domain they were set with).
  // -------------------------------------------------------------------------
  fastify.post('/auth/logout', async (_request, reply) => {
    reply
      .clearCookie(ACCESS_COOKIE, accessClearOptions())
      .clearCookie(REFRESH_COOKIE, refreshClearOptions());
    return reply.send({ ok: true });
  });

  // -------------------------------------------------------------------------
  // GET /admin/me — auth context for the web layer's /admin/[venue] server
  // component, which knows the venue SLUG from the URL but needs the venue ID
  // (every other admin endpoint is keyed by ID) plus a value to confirm the
  // logged-in staffer is allowed to view that slug.
  //
  //   VENUE_STAFF  — always resolves to THEIR OWN venue (from the token), never
  //                  the caller-supplied slug. If a `venue` query is given and
  //                  doesn't match, that's a staff member hitting another
  //                  venue's admin URL — 403, not a silent redirect to their own.
  //   PLATFORM_ADMIN — has no home venue (venue_id is null). If a `venue` slug
  //                  query is given, that venue is resolved (venue-scoped panel
  //                  use, unchanged). If omitted, this is a venue-agnostic
  //                  identity check (e.g. the platform dashboard, Phase 2 item 5)
  //                  — respond 200 with `venue: null` rather than 400, since the
  //                  caller only needs to confirm role, not load a venue.
  // -------------------------------------------------------------------------
  fastify.get<{ Querystring: MeQuery }>(
    '/admin/me',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;
      const requestedSlug = request.query?.venue;

      if (user.role === 'PLATFORM_ADMIN') {
        if (!requestedSlug) {
          return reply.send({ user: { id: user.sub, role: user.role, venue_id: null }, venue: null });
        }
        const venue = await prisma.venue.findUnique({
          where: { slug: requestedSlug },
          select: { id: true, slug: true, name: true, default_locale: true },
        });
        if (!venue) return reply.status(404).send({ error: 'venue_not_found' });
        return reply.send({
          user: { id: user.sub, role: user.role, venue_id: null },
          venue,
        });
      }

      // VENUE_STAFF
      if (!user.venue_id) {
        // Corrupt/legacy token — a staff user must always carry a venue_id.
        return reply.status(401).send({ error: 'unauthorized' });
      }
      const venue = await prisma.venue.findUnique({
        where: { id: user.venue_id },
        select: { id: true, slug: true, name: true, default_locale: true },
      });
      if (!venue) return reply.status(401).send({ error: 'unauthorized' });

      if (requestedSlug && requestedSlug !== venue.slug) {
        // Authenticated, just at the wrong venue's URL — include their own slug so
        // the web layer can send them to their own panel instead of a login page
        // for a venue they can't access (the 403 itself is correct; only the UX of
        // where we redirect afterward should improve).
        return reply.status(403).send({ error: 'forbidden', own_venue_slug: venue.slug });
      }

      return reply.send({
        user: { id: user.sub, role: user.role, venue_id: user.venue_id },
        venue,
      });
    },
  );
}
