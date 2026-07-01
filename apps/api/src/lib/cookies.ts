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

// The refresh cookie is scoped to /auth so it is only ever transmitted to the
// refresh/logout endpoints, not on every ordinary API call.
const REFRESH_PATH = '/auth';

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
  return { ...base(), path: REFRESH_PATH, maxAge: REFRESH_TTL_SECONDS };
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
