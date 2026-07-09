import Redis from 'ioredis';
import { config } from './config';

export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  lazyConnect: true,
});

// Log errors but never crash — Redis outage degrades to Postgres, does not 500
redis.on('error', (err: Error) => {
  process.stderr.write(`[redis] ${err.message}\n`);
});

export async function cacheGet(key: string): Promise<string | null> {
  try {
    return await redis.get(key);
  } catch {
    return null;
  }
}

export async function cacheSet(
  key: string,
  value: string,
  ttlSeconds: number,
): Promise<void> {
  try {
    await redis.set(key, value, 'EX', ttlSeconds);
  } catch {
    // non-fatal — Postgres is the source of truth
  }
}

// ---------------------------------------------------------------------------
// checkRateLimit — minimal fixed-window counter (Section 11). There is no
// @fastify/rate-limit registration anywhere in this codebase yet despite the
// spec naming it; this is a small, route-scoped stand-in built on the Redis
// client that already exists here, not a new library. A future session can
// generalize this into the global /admin/* limiter Section 11 describes.
// ---------------------------------------------------------------------------
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; retryAfter: number }> {
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, windowSeconds);
    }
    if (count > limit) {
      const ttl = await redis.ttl(key);
      return { allowed: false, retryAfter: ttl > 0 ? ttl : windowSeconds };
    }
    return { allowed: true, retryAfter: 0 };
  } catch {
    // Redis outage: fail open, matching cacheGet/cacheSet's non-fatal pattern —
    // availability wins over strict rate limiting when the cache layer is down.
    return { allowed: true, retryAfter: 0 };
  }
}
