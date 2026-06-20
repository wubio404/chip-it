import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/db';
import { cacheGet, cacheSet } from '../lib/redis';

const VENUE_CACHE_TTL = 60; // seconds — matches spec section 12

export async function venueRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { slug: string } }>(
    '/venues/:slug',
    {
      schema: {
        params: {
          type: 'object',
          properties: { slug: { type: 'string', minLength: 1, maxLength: 100 } },
          required: ['slug'],
        },
      },
    },
    async (request, reply) => {
      const { slug } = request.params;
      const cacheKey = `venue:${slug}`;

      // 1. Try Redis cache
      const cached = await cacheGet(cacheKey);
      if (cached) {
        return reply.send(JSON.parse(cached));
      }

      // 2. Cache miss — query Postgres
      const venue = await prisma.venue.findUnique({
        where: { slug },
        select: {
          id: true,
          slug: true,
          name: true,
          logo_url: true,
          primary_color: true,
          default_locale: true,
          pos_type: true,
          stock_buffer: true,
          // Intentionally excluded: pos_credentials, db_config, paymob_config — never sent to the browser
          tables: {
            select: { id: true, label: true, nfc_slug: true },
            orderBy: { label: 'asc' },
          },
          menu_items: {
            // Include unavailable items so the PWA can show "sold out" state
            select: {
              id: true,
              sku: true,
              name: true,
              name_ar: true,
              description: true,
              description_ar: true,
              price: true, // integer piastres — never floats
              category: true,
              category_ar: true,
              available: true,
              stock_count: true,
              image_url: true,
            },
            orderBy: [{ category: 'asc' }, { name: 'asc' }],
          },
        },
      });

      if (!venue) {
        return reply.status(404).send({ error: 'venue_not_found' });
      }

      // 3. Populate cache (non-blocking write — failure is non-fatal)
      await cacheSet(cacheKey, JSON.stringify(venue), VENUE_CACHE_TTL);

      return reply.send(venue);
    },
  );
}
