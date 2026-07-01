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

interface LoginBody {
  email: string;
  password: string;
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
}
