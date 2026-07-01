import jwt from 'jsonwebtoken';
import { config } from './config.js';

// ---------------------------------------------------------------------------
// JWT access + refresh tokens (Section 6).
//
// Two separate secrets and two TTLs: a short-lived access token (15 min) carried
// on every authenticated request, and a long-lived refresh token (7 days) used
// only to mint new access tokens. Using distinct secrets means a leaked access
// secret cannot forge refresh tokens and vice-versa.
// ---------------------------------------------------------------------------

export const ACCESS_TTL_SECONDS = 15 * 60;        // 15 minutes
export const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export type Role = 'PLATFORM_ADMIN' | 'VENUE_STAFF';

// The claims we put on both tokens. `venue_id` is null for PLATFORM_ADMIN.
export interface AuthClaims {
  sub: string;             // user id
  role: Role;
  venue_id: string | null;
}

// `typ` distinguishes the two token kinds so a refresh token can never be
// replayed as an access token (different secret already prevents this, but the
// explicit tag makes verification intent obvious and future-proof).
interface AccessPayload extends AuthClaims { typ: 'access' }
interface RefreshPayload extends AuthClaims { typ: 'refresh' }

export function signAccessToken(claims: AuthClaims): string {
  const payload: AccessPayload = { ...claims, typ: 'access' };
  return jwt.sign(payload, config.jwtAccessSecret, { expiresIn: ACCESS_TTL_SECONDS });
}

export function signRefreshToken(claims: AuthClaims): string {
  const payload: RefreshPayload = { ...claims, typ: 'refresh' };
  return jwt.sign(payload, config.jwtRefreshSecret, { expiresIn: REFRESH_TTL_SECONDS });
}

// Returns the claims on a valid access token, or null on any failure
// (expired, malformed, wrong secret, wrong token type).
export function verifyAccessToken(token: string): AuthClaims | null {
  try {
    const decoded = jwt.verify(token, config.jwtAccessSecret) as AccessPayload;
    if (decoded.typ !== 'access') return null;
    return { sub: decoded.sub, role: decoded.role, venue_id: decoded.venue_id ?? null };
  } catch {
    return null;
  }
}

export function verifyRefreshToken(token: string): AuthClaims | null {
  try {
    const decoded = jwt.verify(token, config.jwtRefreshSecret) as RefreshPayload;
    if (decoded.typ !== 'refresh') return null;
    return { sub: decoded.sub, role: decoded.role, venue_id: decoded.venue_id ?? null };
  } catch {
    return null;
  }
}
