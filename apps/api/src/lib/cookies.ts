import type { CookieSerializeOptions } from '@fastify/cookie';
import { config } from './config.js';
import { ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS } from './jwt.js';

// ---------------------------------------------------------------------------
// httpOnly cookie configuration (Section 6).
//
// Tokens live in httpOnly cookies — never localStorage — so client JS cannot read
// them (XSS mitigation). SameSite/Secure are driven by NODE_ENV:
//
//   Production: the PWA (app.otlobly.org) and API (api.otlobly.org) are different
//     subdomains, so a cross-site request carries the cookie only with
//     SameSite=None; and browsers require Secure whenever SameSite=None. Domain is
//     set to the apex (COOKIE_DOMAIN=otlobly.org) so both subdomains share it.
//
//   Development: API on localhost:3000, web on localhost:3001 — same site (both
//     `localhost`; ports are ignored for the same-site check), so SameSite=Lax is
//     sufficient and lets auth work over plain http (Secure would block that).
//     COOKIE_DOMAIN is left empty locally so no Domain attribute is emitted.
// ---------------------------------------------------------------------------

export const ACCESS_COOKIE = 'access_token';
export const REFRESH_COOKIE = 'refresh_token';

// NOTE: the refresh cookie was originally scoped to Path=/auth so it would only
// ever be transmitted to the refresh/logout endpoints. That breaks through the
// web app's same-origin client proxy (CLIENT_PROXY = '/api-proxy' in
// apps/web/src/lib/api.ts): the browser's actual request path for a refresh call
// is /api-proxy/auth/refresh, which does not start with the literal prefix
// /auth, so per RFC 6265 the Path-scoped cookie is never attached and refresh
// always 401s. The cookie is now scoped to Path=/ (same as the access cookie)
// and relies on httpOnly + SameSite + Secure for protection instead.

function base(): CookieSerializeOptions {
  return {
    httpOnly: true,
    sameSite: config.isProd ? 'none' : 'lax',
    secure: config.isProd, // SameSite=None mandates Secure; prod is HTTPS anyway
    domain: config.cookieDomain || undefined, // apex in prod; unset locally
    path: '/',
  };
}

export function accessCookieOptions(): CookieSerializeOptions {
  return { ...base(), maxAge: ACCESS_TTL_SECONDS };
}

export function refreshCookieOptions(): CookieSerializeOptions {
  return { ...base(), maxAge: REFRESH_TTL_SECONDS };
}

// clearCookie must be called with the SAME path/domain the cookie was set with,
// or the browser keeps the original. These mirror the setters, minus maxAge.
export function accessClearOptions(): CookieSerializeOptions {
  const { maxAge: _drop, ...rest } = accessCookieOptions();
  return rest;
}

export function refreshClearOptions(): CookieSerializeOptions {
  const { maxAge: _drop, ...rest } = refreshCookieOptions();
  return rest;
}
