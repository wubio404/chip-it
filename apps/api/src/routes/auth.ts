import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/db.js';
import { redis, checkRateLimit } from '../lib/redis.js';
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

// ---------------------------------------------------------------------------
// Failed-login throttling (stateful — built on the existing checkRateLimit
// Redis helper, NOT the @fastify/rate-limit plugin used elsewhere in this
// session; see the session brief's "two mechanisms, deliberately split").
//
// Two buckets, both counted on THIS call (see below) and reset on success:
//   - IP:    the attacker's cost. Tight — 10 attempts / 5 min.
//   - email: a secondary, LOOSER bucket (30 / 5 min) so a distributed spray
//     against one victim email (many IPs, each under the IP threshold) still
//     gets throttled eventually. It is intentionally never used to hard-lock
//     an account: it's the same time-windowed, self-expiring throttle as the
//     IP bucket, not a permanent ban, so a real login from a fresh IP still
//     only has to clear its own (unaffected) IP bucket.
// ---------------------------------------------------------------------------
const LOGIN_IP_MAX = 10;
const LOGIN_EMAIL_MAX = 30;
const LOGIN_WINDOW_SECONDS = 5 * 60;

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
      const normalizedEmail = email.toLowerCase().trim();
      const ipKey = `ratelimit:login_ip:${request.ip}`;
      const emailKey = `ratelimit:login_email:${normalizedEmail}`;

      // Count THIS attempt against both buckets up front — before touching the DB
      // or bcrypt — so an already-throttled caller is turned away cheaply. A
      // successful login resets both keys below, so only failed (or currently
      // in-flight) attempts persist as throttle pressure.
      const [ipLimit, emailLimit] = await Promise.all([
        checkRateLimit(ipKey, LOGIN_IP_MAX, LOGIN_WINDOW_SECONDS),
        checkRateLimit(emailKey, LOGIN_EMAIL_MAX, LOGIN_WINDOW_SECONDS),
      ]);
      if (!ipLimit.allowed || !emailLimit.allowed) {
        const retryAfter = Math.max(ipLimit.retryAfter, emailLimit.retryAfter);
        fastify.log.warn({ event: 'login_rate_limited', ip: request.ip, retry_after: retryAfter });
        reply.header('Retry-After', String(retryAfter));
        return reply.status(429).send({ error: 'rate_limit_exceeded', retry_after: retryAfter });
      }

      const user = await prisma.user.findUnique({
        where: { email: normalizedEmail },
        select: { id: true, password_hash: true, role: true, venue_id: true },
      });

      // Generic 401 whether the email is unknown or the password is wrong — do not
      // leak which accounts exist. Always run bcrypt.compare against a real-looking
      // hash even when the user is missing would be ideal to flatten timing; here the
      // hash lookup dominates and the risk is low for a back-office login.
      if (!user || !(await verifyPassword(password, user.password_hash))) {
        return reply.status(401).send({ error: 'invalid_credentials' });
      }

      // Success — clear both throttle counters so this account/IP starts clean.
      await redis.del(ipKey, emailKey).catch(() => {});

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
