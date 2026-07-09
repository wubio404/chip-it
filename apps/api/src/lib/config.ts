import 'dotenv/config';

// JWT secrets are REQUIRED — the auth layer must fail fast rather than boot with a
// weak/absent signing key. Rotating either secret invalidates all existing sessions
// (a forced re-login), which is the intended kill-switch, not a graceful transition.
const REQUIRED = ['DATABASE_URL', 'REDIS_URL', 'PORT', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const;

for (const key of REQUIRED) {
  if (!process.env[key]) {
    process.stderr.write(`FATAL: missing required env var: ${key}\n`);
    process.exit(1);
  }
}

// ─── PRODUCTION AUTH CHECKLIST (Section 6) ───────────────────────────────────
// Auth cookies and JWTs misbehave silently if these are wrong in prod:
//   1. JWT_ACCESS_SECRET / JWT_REFRESH_SECRET — set to FRESH random values on the
//      server (never reuse the dev values). Required: the API refuses to boot
//      without them. Rotating either forces a global re-login.
//   2. NODE_ENV=production — flips cookies to SameSite=None; Secure (see
//      lib/cookies.ts). Miss this and cross-subdomain auth breaks (cookies stay Lax).
//   3. COOKIE_DOMAIN=otlobly.org (apex) — so app.otlobly.org and api.otlobly.org
//      share the cookie. Miss this and the browser scopes it to api. only.
// ─────────────────────────────────────────────────────────────────────────────
export const config = {
  databaseUrl: process.env.DATABASE_URL!,
  redisUrl: process.env.REDIS_URL!,
  port: Number(process.env.PORT!),
  // Drives cookie SameSite/Secure (see lib/cookies.ts). Defaults to development.
  // PROD: must be "production" or cookies stay SameSite=Lax and cross-subdomain auth breaks.
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProd: (process.env.NODE_ENV ?? 'development') === 'production',
  // Signing secrets for the two token types. Access is short-lived (15m),
  // refresh long-lived (7d). Presence guaranteed by the REQUIRED check above.
  // PROD: set FRESH random values on the server — never reuse the dev secrets.
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET!,
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET!,
  // Online-payment URLs. Not in REQUIRED — the cash path boots without them.
  // Validated at request time when a CARD/APPLE_PAY order is created.
  appBaseUrl: process.env.APP_BASE_URL ?? '',     // web app public origin — used for Paymob redirection_url
  apiBaseUrl: process.env.API_BASE_URL ?? '',     // this server's public origin — used for Paymob notification_url
  cookieDomain: process.env.COOKIE_DOMAIN ?? '',  // apex domain for cross-subdomain cookies; leave empty locally. PROD: otlobly.org (else app./api. can't share the auth cookie)
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:3001',  // allowed CORS origin
  guestEmail: process.env.PLATFORM_GUEST_EMAIL ?? 'guest@example.com',  // placeholder for Paymob billing_data
  // Cloudflare R2 (S3-compatible) — menu image uploads (Section 12 / Phase 2 item 4).
  // Not in REQUIRED: validated at request time in lib/r2.ts, same pattern as Paymob.
  r2AccountId: process.env.R2_ACCOUNT_ID ?? '',
  r2AccessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
  r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
  r2Bucket: process.env.R2_BUCKET ?? '',
  r2PublicBaseUrl: process.env.R2_PUBLIC_BASE_URL ?? '',
} as const;
