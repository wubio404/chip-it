// config must be the very first import — it loads dotenv and validates env vars
import './lib/config.js';

import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cron from 'node-cron';
import { config } from './lib/config.js';
import { prisma } from './lib/db.js';
import { redis } from './lib/redis.js';
import { healthRoutes } from './routes/health.js';
import { venueRoutes } from './routes/venues.js';
import { orderRoutes, expireStaleOrders } from './routes/orders.js';
import { webhookRoutes } from './routes/webhooks.js';
import { agentRoutes } from './routes/agent.js';

const server = Fastify({ logger: true });

server.register(websocket);
server.register(healthRoutes);
server.register(venueRoutes);
server.register(orderRoutes);
server.register(webhookRoutes);
server.register(agentRoutes);

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
