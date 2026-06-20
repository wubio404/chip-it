import 'dotenv/config';

const REQUIRED = ['DATABASE_URL', 'REDIS_URL', 'PORT'] as const;

for (const key of REQUIRED) {
  if (!process.env[key]) {
    process.stderr.write(`FATAL: missing required env var: ${key}\n`);
    process.exit(1);
  }
}

export const config = {
  databaseUrl: process.env.DATABASE_URL!,
  redisUrl: process.env.REDIS_URL!,
  port: Number(process.env.PORT!),
  // Online-payment URLs. Not in REQUIRED — the cash path boots without them.
  // Validated at request time when a CARD/APPLE_PAY order is created.
  frontendUrl: process.env.FRONTEND_URL ?? '',
  webhookBaseUrl: process.env.WEBHOOK_BASE_URL ?? '',
} as const;
