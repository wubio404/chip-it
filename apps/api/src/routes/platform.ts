import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { reverseOrderPayment, PaymobReversalError } from '../services/refunds.js';

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
}
