import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { reverseOrderPayment, PaymobReversalError } from '../services/refunds.js';
import { startOfDayUTC } from '../lib/timezone.js';

const PLATFORM_TZ = 'Africa/Cairo';

// §14: an agent is marked OFFLINE if no heartbeat has been seen in this window.
// Applied here as a read-time derivation for the dashboard badge — the actual
// sweep-and-write-to-DB job is Phase 3, not built yet.
const AGENT_OFFLINE_THRESHOLD_MS = 90_000;

// Canonical OrderStatus list (§5.2/5.3) — used to zero-fill the summary's
// today-by-status breakdown so an empty day returns real zeros, not gaps.
const ORDER_STATUSES = [
  'CREATED', 'PAYMENT_PENDING', 'CONFIRMED', 'ROUTING', 'INJECTED',
  'PRINTED', 'FULFILLED', 'CANCELLED', 'FAILED', 'EXPIRED',
] as const;

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

  // ---------------------------------------------------------------------------
  // POST /platform/refunds/sweep — reverse "paid_after_cancel" orders (5.9).
  //
  // Targets orders the webhook flagged: a customer cancelled (or the order expired)
  // while payment was in flight, then the payment landed — leaving status
  // CANCELLED/EXPIRED with payment_status PAID (see webhooks.ts 'paid_after_cancel').
  // The reversal client refunds/voids each and moves it to REFUNDED/VOIDED.
  //
  // Idempotent & safe to re-run: a reversed order no longer matches payment_status
  // PAID, and reverseOrderPayment itself skips anything already reversed.
  // ---------------------------------------------------------------------------
  fastify.post(
    '/platform/refunds/sweep',
    { preHandler: [requireAuth, requireRole('PLATFORM_ADMIN')] },
    async (request, reply) => {
      const candidates = await prisma.order.findMany({
        where: {
          status: { in: ['CANCELLED', 'EXPIRED'] },
          payment_status: 'PAID',
          payment_method: { in: ['CARD', 'APPLE_PAY'] }, // cash has no Paymob txn
        },
        select: { id: true, venue_id: true },
      });

      const results: Array<Record<string, unknown>> = [];
      let reversed = 0;
      let failed = 0;

      for (const { id, venue_id } of candidates) {
        try {
          const outcome = await reverseOrderPayment(id, { trigger: 'paid_after_cancel_sweep', log: fastify.log });
          if (outcome.ok) {
            reversed += 1;
            results.push({ order_id: id, ok: true, mode: outcome.mode, reversal_id: outcome.reversalId, already: outcome.alreadyReversed });
          } else {
            failed += 1;
            results.push({ order_id: id, ok: false, reason: outcome.reason });
          }
        } catch (err) {
          failed += 1;
          const msg = err instanceof PaymobReversalError ? err.message : String(err);
          fastify.log.error({ event: 'sweep_reversal_failed', order_id: id, venue_id, error: msg });
          results.push({ order_id: id, ok: false, error: msg });
        }
      }

      fastify.log.info({ event: 'paid_after_cancel_sweep', found: candidates.length, reversed, failed });
      return reply.send({ found: candidates.length, reversed, failed, results });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /platform/venues — read-only cross-venue overview (Phase 2 item 5).
  // PLATFORM_ADMIN only. Built from a handful of grouped aggregates (not a
  // per-venue query loop): one findMany for venue+agent rows, plus three
  // groupBy aggregates keyed by venue_id.
  //
  // "Today" is the Africa/Cairo calendar day (matching admin.ts's ORDER_TZ).
  // orders_total / orders_today key off created_at; revenue_today keys off
  // paid_at — a cash order CREATED yesterday but COLLECTED today counts toward
  // today's revenue, not toward today's order count. Easy to get backward.
  // ---------------------------------------------------------------------------
  fastify.get(
    '/platform/venues',
    {
      preHandler: [requireAuth, requireRole('PLATFORM_ADMIN')],
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              venues: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    slug: { type: 'string' },
                    name: { type: 'string' },
                    active: { type: 'boolean' },
                    pos_type: { type: 'string' },
                    created_at: { type: 'string' },
                    orders_total: { type: 'integer' },
                    orders_today: { type: 'integer' },
                    revenue_today: { type: 'integer' },
                    agent: {
                      type: ['object', 'null'],
                      properties: {
                        status: { type: 'string' },
                        last_heartbeat: { type: ['string', 'null'] },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      const since = startOfDayUTC(PLATFORM_TZ);

      const [venues, totalCounts, todayCounts, todayRevenue] = await Promise.all([
        prisma.venue.findMany({
          select: {
            id: true, slug: true, name: true, active: true, pos_type: true, created_at: true,
            agents: { select: { status: true, last_heartbeat: true }, take: 1 },
          },
        }),
        prisma.order.groupBy({ by: ['venue_id'], _count: { _all: true } }),
        prisma.order.groupBy({ by: ['venue_id'], where: { created_at: { gte: since } }, _count: { _all: true } }),
        prisma.order.groupBy({
          by: ['venue_id'],
          where: { payment_status: 'PAID', paid_at: { gte: since } },
          _sum: { total: true },
        }),
      ]);

      const totalByVenue = new Map(totalCounts.map((r) => [r.venue_id, r._count._all]));
      const todayByVenue = new Map(todayCounts.map((r) => [r.venue_id, r._count._all]));
      const revenueByVenue = new Map(todayRevenue.map((r) => [r.venue_id, r._sum.total ?? 0]));

      const now = Date.now();
      const rows = venues.map((v) => {
        const agentRow = v.agents[0];
        let agent = null;
        if (agentRow) {
          const heartbeatAgeMs = agentRow.last_heartbeat ? now - agentRow.last_heartbeat.getTime() : null;
          const stale = heartbeatAgeMs === null || heartbeatAgeMs > AGENT_OFFLINE_THRESHOLD_MS;
          agent = {
            status: stale ? 'OFFLINE' : agentRow.status,
            last_heartbeat: agentRow.last_heartbeat?.toISOString() ?? null,
          };
        }
        return {
          id: v.id,
          slug: v.slug,
          name: v.name,
          active: v.active,
          pos_type: v.pos_type,
          created_at: v.created_at.toISOString(),
          orders_total: totalByVenue.get(v.id) ?? 0,
          orders_today: todayByVenue.get(v.id) ?? 0,
          revenue_today: revenueByVenue.get(v.id) ?? 0,
          agent,
        };
      });

      // Busiest first (today's order count desc); ties broken by name so the
      // list order is stable across refreshes instead of shuffling arbitrarily.
      rows.sort((a, b) => b.orders_today - a.orders_today || a.name.localeCompare(b.name));

      fastify.log.info({ event: 'platform_venues_overview', venue_count: rows.length });
      return reply.send({ venues: rows });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /platform/summary — platform-wide totals (Phase 2 item 5). PLATFORM_ADMIN
  // only. Same "today" boundary and created_at/paid_at split as /platform/venues
  // above. The status breakdown is zero-filled for every OrderStatus so a quiet
  // day returns real zeros rather than an incomplete object.
  // ---------------------------------------------------------------------------
  fastify.get(
    '/platform/summary',
    {
      preHandler: [requireAuth, requireRole('PLATFORM_ADMIN')],
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              venues_total: { type: 'integer' },
              venues_active: { type: 'integer' },
              orders_today: { type: 'integer' },
              revenue_today: { type: 'integer' },
              orders_today_by_status: {
                type: 'object',
                properties: Object.fromEntries(ORDER_STATUSES.map((s) => [s, { type: 'integer' }])),
              },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      const since = startOfDayUTC(PLATFORM_TZ);

      const [venuesTotal, venuesActive, ordersToday, revenueToday, statusBreakdown] = await Promise.all([
        prisma.venue.count(),
        prisma.venue.count({ where: { active: true } }),
        prisma.order.count({ where: { created_at: { gte: since } } }),
        prisma.order.aggregate({
          where: { payment_status: 'PAID', paid_at: { gte: since } },
          _sum: { total: true },
        }),
        prisma.order.groupBy({ by: ['status'], where: { created_at: { gte: since } }, _count: { _all: true } }),
      ]);

      const ordersTodayByStatus = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0])) as Record<
        (typeof ORDER_STATUSES)[number],
        number
      >;
      for (const row of statusBreakdown) {
        ordersTodayByStatus[row.status] = row._count._all;
      }

      fastify.log.info({ event: 'platform_summary' });
      return reply.send({
        venues_total: venuesTotal,
        venues_active: venuesActive,
        orders_today: ordersToday,
        revenue_today: revenueToday._sum.total ?? 0,
        orders_today_by_status: ordersTodayByStatus,
      });
    },
  );
}
