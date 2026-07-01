import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/db.js';
import { redis } from '../lib/redis.js';
import { requireAuth, requireVenueMatch } from '../middleware/auth.js';

interface ToggleParams {
  id: string;   // venue id — venue-scoped (requireVenueMatch enforces it matches the staff token)
  sku: string;
}

// Venue-scoped staff surface (Section 5.2). VENUE_STAFF may only touch their own
// venue; PLATFORM_ADMIN may touch any. The scoping is enforced by requireVenueMatch
// server-side, independent of the URL the caller constructs.
export async function adminRoutes(fastify: FastifyInstance) {
  // POST /admin/venues/:id/items/:sku/toggle — flip item availability (5.7).
  fastify.post<{ Params: ToggleParams }>(
    '/admin/venues/:id/items/:sku/toggle',
    {
      preHandler: [requireAuth, requireVenueMatch('id')],
      schema: {
        params: {
          type: 'object',
          required: ['id', 'sku'],
          properties: {
            id:  { type: 'string', minLength: 1 },
            sku: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id: venueId, sku } = request.params;

      const item = await prisma.menuItem.findFirst({
        where: { venue_id: venueId, sku },
        select: { id: true, available: true, venue: { select: { slug: true } } },
      });
      if (!item) {
        return reply.status(404).send({ error: 'item_not_found' });
      }

      const updated = await prisma.menuItem.update({
        where: { id: item.id },
        data: { available: !item.available },
        select: { sku: true, available: true },
      });

      // Invalidate the venue cache immediately so the "sold out" flip is visible
      // without waiting out the 60s TTL (spec Section 12).
      await redis.del(`venue:${item.venue.slug}`).catch(() => {});

      fastify.log.info({ event: 'admin_item_toggle', venue_id: venueId, sku, available: updated.available });
      return reply.send(updated);
    },
  );
}
