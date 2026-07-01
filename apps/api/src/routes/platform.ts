import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

// Platform-admin-only surface (Section 5.2: `GET /platform/agents` → agent health
// dashboard). Guarded here; the dashboard UI itself is a later session.
export async function platformRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/platform/agents',
    { preHandler: [requireAuth, requireRole('PLATFORM_ADMIN')] },
    async () => {
      const agents = await prisma.agent.findMany({
        select: {
          id: true,
          venue_id: true,
          status: true,
          current_tier: true,
          schema_ok: true,
          last_heartbeat: true,
          venue: { select: { slug: true, name: true } },
        },
        orderBy: { venue_id: 'asc' },
      });
      return { agents };
    },
  );
}
