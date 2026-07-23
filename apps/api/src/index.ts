// config must be the very first import — it loads dotenv and validates env vars
import './lib/config.js';

import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import cron from 'node-cron';
import { config } from './lib/config.js';
import { prisma } from './lib/db.js';
import { redis } from './lib/redis.js';
import { buildRateLimitOptions } from './lib/rate-limit.js';
import { healthRoutes } from './routes/health.js';
import { venueRoutes } from './routes/venues.js';
import { orderRoutes, expireStaleOrders } from './routes/orders.js';
import { webhookRoutes } from './routes/webhooks.js';
import { agentRoutes } from './routes/agent.js';
import { authRoutes } from './routes/auth.js';
import { platformRoutes } from './routes/platform.js';
import { adminRoutes } from './routes/admin.js';

// trustProxy: the API runs behind Nginx (and Cloudflare) in production, so the
// real client IP arrives via X-Forwarded-For. Without this, Fastify sees the
// proxy's loopback address and the per-IP rate limits (Section 11) all key on
// the same IP. Enabling it makes request.ip the forwarded client IP.
const server = Fastify({ logger: true, trustProxy: true });

server.register(cors, { origin: config.corsOrigin, credentials: true });
server.register(cookie); // parses Cookie header into request.cookies; enables reply.setCookie/clearCookie
// Registered AFTER cookie so request.cookies is already parsed when the
// plugin's onRequest hook runs our keyGenerator/logging (Section 11).
// global: false — only routes that opt in via `config.rateLimit` are limited.
server.register(rateLimit, buildRateLimitOptions(server.log));
server.register(websocket);
server.register(healthRoutes);
server.register(venueRoutes);
server.register(orderRoutes);       // customer flow — intentionally UNAUTHENTICATED (guest)
server.register(webhookRoutes);
server.register(agentRoutes);
server.register(authRoutes);        // login / refresh / logout
server.register(platformRoutes);    // platform-admin-only surfaces
server.register(adminRoutes);       // venue-scoped staff surfaces

const shutdown = async (signal: string) => {
  server.log.info({ signal }, 'Shutdown signal received');
  await server.close();
  await prisma.$disconnect();
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const start = async () => {
  try {
    await redis.connect().catch((err: Error) => {
      server.log.warn({ err: err.message }, 'Redis unavailable at startup — cache disabled');
    });

    // Listen dual-stack (IPv6 '::' accepts IPv4 too). On Windows `localhost`
    // resolves to IPv6 [::1] first; binding IPv4-only ('0.0.0.0') makes tools
    // that target localhost (e.g. the ngrok agent) fail with connection refused.
    await server.listen({ port: config.port, host: '::' });

    // Expire CREATED orders older than 10 minutes, releasing their stock reservations.
    // Runs every 60 seconds. Each expiry is transaction-locked to prevent races with cancel.
    cron.schedule('* * * * *', async () => {
      try {
        await expireStaleOrders();
      } catch (err) {
        server.log.error({ event: 'cron_expiry_error', error: String(err) });
      }
    });

    server.log.info({ event: 'cron_started', schedule: 'every 60s', task: 'expireStaleOrders' });
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
