import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/db.js';
import { redis } from '../lib/redis.js';
import { requireAuth, requireVenueMatch } from '../middleware/auth.js';
import { releaseReservation, restockCommitted } from '../services/inventory.js';
import { reverseOrderPayment, PaymobReversalError } from '../services/refunds.js';

interface ToggleParams {
  id: string;   // venue id — venue-scoped (requireVenueMatch enforces it matches the staff token)
  sku: string;
}

interface OrderActionParams {
  venueId: string;
  orderId: string;
}

interface CancelBody {
  reason?: string;
}

// Staff may cancel any time before FULFILLED (5.9). Terminal/uncancellable states rejected.
const CANCELLABLE = new Set(['CREATED', 'PAYMENT_PENDING', 'CONFIRMED', 'ROUTING', 'INJECTED', 'PRINTED']);
// States in which stock has already been COMMITTED (decremented) — restock on cancel.
const COMMITTED = new Set(['CONFIRMED', 'ROUTING', 'INJECTED', 'PRINTED']);

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
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

  // Invalidate the cached venue menu after a stock-affecting change (5.7 / Section 12).
  async function invalidateVenueCache(venueId: string): Promise<void> {
    const v = await prisma.venue.findUnique({ where: { id: venueId }, select: { slug: true } });
    if (v) await redis.del(`venue:${v.slug}`).catch(() => {});
  }

  // Cancel an UNPAID (or cash) order: release-or-restock stock and mark CANCELLED,
  // WITHOUT any Paymob call. Locked + re-validated to guard against races with the
  // webhook. Paid-online orders never reach here — they go through reverseOrderPayment.
  async function cancelWithoutReversal(orderId: string, reason: string | null) {
    return prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{
        venue_id: string;
        status: string;
        payment_status: string;
        payment_method: string;
        items: Array<{ sku: string; qty: number }>;
      }>>`
        SELECT venue_id, status, payment_status, payment_method, items
        FROM "Order" WHERE id = ${orderId} FOR UPDATE
      `;
      if (rows.length === 0) throw httpError(404, 'order_not_found');
      const o = rows[0];
      if (!CANCELLABLE.has(o.status)) throw httpError(409, 'cancel_not_allowed');

      const items = (Array.isArray(o.items) ? o.items : []).map((i) => ({ sku: i.sku, qty: i.qty }));

      if (COMMITTED.has(o.status)) {
        await restockCommitted(tx, o.venue_id, items);
      } else {
        await releaseReservation(tx, o.venue_id, items);
      }

      await tx.order.update({ where: { id: orderId }, data: { status: 'CANCELLED', cancel_reason: reason } });

      // A collected-cash order carries payment_status PAID but has no Paymob txn —
      // any money return is a physical cash refund, out of scope here. Flag it.
      if (o.payment_status === 'PAID' && o.payment_method === 'CASH') {
        fastify.log.warn({ event: 'cash_order_cancelled_after_paid', order_id: orderId, note: 'manual cash refund may be required' });
      }
      return { venue_id: o.venue_id, payment_status: o.payment_status };
    });
  }

  // ---------------------------------------------------------------------------
  // POST /admin/venues/:venueId/orders/:orderId/cancel — staff cancel (5.9).
  // Allowed any time before FULFILLED. If the order was paid online, the reversal
  // client fires (void→refund); an unpaid/cash order is cancelled with no Paymob.
  //
  // Auth: requireAuth + requireVenueMatch('venueId'). requireVenueMatch already
  // encodes "PLATFORM_ADMIN, or VENUE_STAFF whose token venue matches" — the exact
  // "VENUE_STAFF or PLATFORM_ADMIN + venue scoping" rule from the brief — so a
  // separate requireRole would be redundant (and can't express the OR).
  // ---------------------------------------------------------------------------
  fastify.post<{ Params: OrderActionParams; Body: CancelBody }>(
    '/admin/venues/:venueId/orders/:orderId/cancel',
    {
      preHandler: [requireAuth, requireVenueMatch('venueId')],
      schema: {
        params: {
          type: 'object',
          required: ['venueId', 'orderId'],
          properties: {
            venueId: { type: 'string', minLength: 1 },
            orderId: { type: 'string', minLength: 1 },
          },
        },
        body: { type: 'object', properties: { reason: { type: 'string', maxLength: 500 } } },
      },
    },
    async (request, reply) => {
      const { venueId, orderId } = request.params;
      const reason = request.body?.reason ?? null;

      // Scope the order to the venue in the URL (belt-and-braces with requireVenueMatch).
      const pre = await prisma.order.findFirst({
        where: { id: orderId, venue_id: venueId },
        select: { id: true, status: true, payment_method: true },
      });
      if (!pre) return reply.status(404).send({ error: 'order_not_found' });
      if (!CANCELLABLE.has(pre.status)) {
        return reply.status(409).send({ error: 'cancel_not_allowed', message: 'Order is FULFILLED or already terminal' });
      }

      const isOnline = pre.payment_method === 'CARD' || pre.payment_method === 'APPLE_PAY';

      // ONLINE: route through the reversal client first. It locks + re-checks payment
      // status under the lock, so a payment landing between this pre-read and the lock
      // is handled correctly (no torn state).
      if (isOnline) {
        try {
          const outcome = await reverseOrderPayment(orderId, {
            trigger: 'staff_cancel',
            finalStatus: 'CANCELLED',
            cancelReason: reason,
            log: fastify.log,
          });

          if (outcome.ok) {
            await invalidateVenueCache(venueId);
            fastify.log.info({ event: 'staff_cancel_reversed', order_id: orderId, venue_id: venueId, mode: outcome.mode, reversal_id: outcome.reversalId, already: outcome.alreadyReversed });
            return reply.send({
              ok: true,
              status: 'CANCELLED',
              payment_status: outcome.mode === 'void' ? 'VOIDED' : 'REFUNDED',
              reversal_mode: outcome.mode,
              reversal_id: outcome.reversalId,
            });
          }

          // Not actually paid yet (still CREATED/PAYMENT_PENDING) → cancel with no Paymob.
          if (outcome.reason === 'not_paid') {
            await cancelWithoutReversal(orderId, reason);
            await invalidateVenueCache(venueId);
            fastify.log.info({ event: 'staff_cancel', order_id: orderId, venue_id: venueId, payment: 'unpaid_online' });
            return reply.send({ ok: true, status: 'CANCELLED', payment_status: 'UNPAID' });
          }
          if (outcome.reason === 'not_found') return reply.status(404).send({ error: 'order_not_found' });
          if (outcome.reason === 'not_cancellable') return reply.status(409).send({ error: 'cancel_not_allowed' });
          if (outcome.reason === 'no_transaction_ref') {
            // Paid online but no stored transaction id — cannot reverse automatically.
            return reply.status(409).send({ error: 'reversal_unavailable', message: 'Paid order has no Paymob transaction ref; reconcile manually' });
          }
          return reply.status(409).send({ error: outcome.reason });
        } catch (err) {
          if (err instanceof PaymobReversalError) {
            // Distinguish a misconfiguration (our fault, fix + restart) from a genuine
            // Paymob double-decline — both leave payment_status untouched, but the
            // operator response is different.
            const notConfigured = err.message === 'paymob_reversal_not_configured';
            fastify.log.error({ event: 'staff_cancel_reversal_failed', order_id: orderId, venue_id: venueId, error: err.message });
            return reply.status(notConfigured ? 500 : 502).send(
              notConfigured
                ? { error: 'reversal_not_configured', message: 'PAYMOB_API_KEY is missing from the API server environment — add it to .env and RESTART the server' }
                : { error: 'reversal_failed', message: 'Paymob void and refund both failed; order left PAID for retry' },
            );
          }
          throw err;
        }
      }

      // CASH / unpaid path — no Paymob.
      try {
        const r = await cancelWithoutReversal(orderId, reason);
        await invalidateVenueCache(venueId);
        fastify.log.info({ event: 'staff_cancel', order_id: orderId, venue_id: venueId, payment: 'cash_or_unpaid' });
        return reply.send({ ok: true, status: 'CANCELLED', payment_status: r.payment_status });
      } catch (err: unknown) {
        const e = err as Error & { statusCode?: number };
        if (e.statusCode === 404) return reply.status(404).send({ error: 'order_not_found' });
        if (e.statusCode === 409) return reply.status(409).send({ error: 'cancel_not_allowed' });
        throw err;
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /admin/venues/:venueId/orders/:orderId/collect — mark a cash order paid (5.9).
  // Only a CASH order that is confirmed/routed and still UNPAID. No Paymob (cash has
  // no transaction). 409 for non-cash or already-paid.
  // ---------------------------------------------------------------------------
  fastify.post<{ Params: OrderActionParams }>(
    '/admin/venues/:venueId/orders/:orderId/collect',
    {
      preHandler: [requireAuth, requireVenueMatch('venueId')],
      schema: {
        params: {
          type: 'object',
          required: ['venueId', 'orderId'],
          properties: {
            venueId: { type: 'string', minLength: 1 },
            orderId: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { venueId, orderId } = request.params;

      try {
        await prisma.$transaction(async (tx) => {
          const rows = await tx.$queryRaw<Array<{
            venue_id: string;
            status: string;
            payment_method: string;
            payment_status: string;
          }>>`
            SELECT venue_id, status, payment_method, payment_status
            FROM "Order" WHERE id = ${orderId} FOR UPDATE
          `;
          if (rows.length === 0 || rows[0].venue_id !== venueId) throw httpError(404, 'order_not_found');
          const o = rows[0];

          if (o.payment_method !== 'CASH') throw httpError(409, 'not_a_cash_order');
          if (o.payment_status !== 'UNPAID') throw httpError(409, 'already_paid');
          // Must be confirmed/routed (a cash order auto-confirms on creation).
          if (!COMMITTED.has(o.status) && o.status !== 'FULFILLED') throw httpError(409, 'not_collectable');

          await tx.order.update({
            where: { id: orderId },
            data: { payment_status: 'PAID', paid_at: new Date() },
          });
        });

        fastify.log.info({ event: 'cash_collected', order_id: orderId, venue_id: venueId });
        return reply.send({ ok: true, payment_status: 'PAID' });
      } catch (err: unknown) {
        const e = err as Error & { statusCode?: number };
        if (e.statusCode === 404) return reply.status(404).send({ error: 'order_not_found' });
        if (e.statusCode === 409) return reply.status(409).send({ error: e.message });
        throw err;
      }
    },
  );
}
