import type { FastifyReply, FastifyRequest } from 'fastify';
import { ACCESS_COOKIE } from '../lib/cookies.js';
import { verifyAccessToken, type AuthClaims, type Role } from '../lib/jwt.js';

// Attach the authenticated principal to the request for downstream handlers.
declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthClaims;
  }
}

// ---------------------------------------------------------------------------
// requireAuth — rejects 401 unless a valid, unexpired access-token cookie is
// present. On success, populates request.user for later preHandlers/handlers.
// ---------------------------------------------------------------------------
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies?.[ACCESS_COOKIE];
  const claims = token ? verifyAccessToken(token) : null;
  if (!claims) {
    return reply.status(401).send({ error: 'unauthorized' });
  }
  request.user = claims;
}

// ---------------------------------------------------------------------------
// requireRole — 403 if the authenticated user's role doesn't match. Must run
// after requireAuth (which populates request.user); guards against misordering
// by treating a missing principal as 401.
// ---------------------------------------------------------------------------
export function requireRole(role: Role) {
  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!request.user) return reply.status(401).send({ error: 'unauthorized' });
    if (request.user.role !== role) {
      return reply.status(403).send({ error: 'forbidden' });
    }
  };
}

// ---------------------------------------------------------------------------
// requireVenueMatch — server-side venue scoping. A VENUE_STAFF user may only act
// on their own venue; the token's venue_id must equal the venue id in the route.
// PLATFORM_ADMIN bypasses the check (full cross-venue access).
//
// This is the one auth control that actually matters here: without it, a staff
// login for venue A could read venue B's data just by guessing the URL. `paramName`
// is the route param that carries the venue id (default `id`, e.g. /admin/venues/:id/...).
// ---------------------------------------------------------------------------
export function requireVenueMatch(paramName = 'id') {
  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!request.user) return reply.status(401).send({ error: 'unauthorized' });
    if (request.user.role === 'PLATFORM_ADMIN') return; // full access, no scoping

    const routeVenueId = (request.params as Record<string, string | undefined>)[paramName];
    if (!routeVenueId || request.user.venue_id !== routeVenueId) {
      return reply.status(403).send({ error: 'forbidden' });
    }
  };
}
