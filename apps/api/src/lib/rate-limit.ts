import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import type { RateLimitPluginOptions } from '@fastify/rate-limit';
import { redis } from './redis.js';
import { ACCESS_COOKIE } from './cookies.js';
import { verifyAccessToken } from './jwt.js';

// ---------------------------------------------------------------------------
// Section 11 — blanket per-route rate limiting via @fastify/rate-limit,
// state kept in the EXISTING ioredis client (lib/redis.ts), not a second
// connection. Registered with `global: false` in index.ts so only routes
// that opt in via `config.rateLimit` are limited (see each route file).
// ---------------------------------------------------------------------------

// Resolves "who is making this request" from the access-token cookie directly
// rather than `request.user`, because this runs in the plugin's `onRequest`
// hook, which fires BEFORE a route's own `requireAuth` preHandler populates
// `request.user`. Falls back to IP when unauthenticated/unverifiable.
//
// Used as the keyGenerator for POST /admin/* (5.2/11 — keyed per AUTHENTICATED
// USER, not IP, so a shared venue kitchen IP doesn't throttle every staff
// member as one bucket) and, generically, to label who tripped any limiter
// in the shared errorResponseBuilder log line below.
export function resolveRequesterKey(request: FastifyRequest): string {
  const token = request.cookies?.[ACCESS_COOKIE];
  const claims = token ? verifyAccessToken(token) : null;
  return claims ? `user:${claims.sub}` : `ip:${request.ip}`;
}

// Builds the exact §11 429 shape: `{ error: "rate_limit_exceeded", retry_after }`.
// `statusCode` is attached non-enumerable so Fastify's default error handler
// (which reads `error.statusCode` to set the HTTP status) still sees it, but
// JSON.stringify — which only serializes enumerable own properties — omits it
// from the response body.
function rateLimitBody(retryAfterSeconds: number): { error: string; retry_after: number } {
  const body = { error: 'rate_limit_exceeded', retry_after: retryAfterSeconds };
  Object.defineProperty(body, 'statusCode', { value: 429, enumerable: false });
  return body;
}

export function buildRateLimitOptions(log: FastifyBaseLogger): RateLimitPluginOptions {
  return {
    global: false, // routes opt in individually via `config.rateLimit`
    redis,          // reuse the existing ioredis client — survives restarts, shared across instances
    nameSpace: 'fastify-rate-limit:',
    errorResponseBuilder: (request, context) => {
      const retryAfter = Math.ceil(context.ttl / 1000);
      log.warn({
        event: 'rate_limit_exceeded',
        path: request.url,
        method: request.method,
        key: resolveRequesterKey(request),
        retry_after: retryAfter,
      });
      return rateLimitBody(retryAfter);
    },
  };
}
