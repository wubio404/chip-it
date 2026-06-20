import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/db.js';
import { commitStock } from '../services/inventory.js';
import { routeOrder } from '../connectors/router.js';
import { getPaymobConfig, verifyPaymobHmac } from '../lib/paymob.js';
import type { CanonicalOrder } from '@taporder/types';

interface PaymobWebhookQuery {
  hmac?: string;
}

interface PaymobWebhookBody {
  type?: string;
  obj?: Record<string, unknown>;
  hmac?: string;
}

// Read a possibly-nested field as the original webhook payload presents it.
function field(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => {
    if (o == null || typeof o !== 'object') return undefined;
    return (o as Record<string, unknown>)[k];
  }, obj);
}

// Tolerant boolean read — Paymob normally sends JSON booleans, but accept the
// stringified form too so a serialization quirk can't misread a flag.
function isTrue(v: unknown): boolean {
  return v === true || v === 'true';
}

type OrderItemSnapshot = {
  sku: string;
  pos_sku?: string;
  name: string;
  qty: number;
  unit_price: number;
};

export async function webhookRoutes(fastify: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // POST /webhooks/paymob — payment result callback (Section 5.8 / Appendix 21.4)
  //
  // Paymob POSTs { type, obj } and places `hmac` as a QUERY parameter.
  // We verify the HMAC with constant-time compare BEFORE acting on anything.
  // ---------------------------------------------------------------------------
  fastify.post<{ Querystring: PaymobWebhookQuery; Body: PaymobWebhookBody }>(
    '/webhooks/paymob',
    async (request, reply) => {
      const body = request.body ?? {};
      const obj = body.obj;
      // hmac arrives as a query param; tolerate a body copy as a fallback.
      const receivedHmac = request.query?.hmac ?? body.hmac ?? '';

      if (!obj || typeof obj !== 'object') {
        fastify.log.warn({ event: 'paymob_webhook_no_obj' });
        return reply.status(400).send({ error: 'bad_payload' });
      }

      // Correlate to our order via special_reference → merchant_order_id.
      const merchantOrderId = field(obj, 'order.merchant_order_id');
      const ourOrderId = typeof merchantOrderId === 'string' ? merchantOrderId : null;

      const order = ourOrderId
        ? await prisma.order.findUnique({
            where: { id: ourOrderId },
            select: {
              id: true, venue_id: true, status: true, payment_status: true,
              total: true, items: true, customer_name: true, table_label: true,
              payment_method: true,
              venue: { select: { id: true, pos_type: true, paymob_config: true } },
            },
          })
        : null;

      // Resolve the venue's Paymob secret to verify the signature. When the order
      // (and thus venue) is unknown we fall back to env config, which today is the
      // single test account anyway. TODO: per-venue decrypt of venue.paymob_config.
      const paymobCfg = getPaymobConfig({
        id: order?.venue.id ?? '',
        paymob_config: order?.venue.paymob_config ?? undefined,
      });

      // --- HMAC verification (constant-time). Reject before any state change. ---
      const { valid, source } = verifyPaymobHmac(obj, receivedHmac, paymobCfg.hmacSecret);
      if (!valid) {
        // Temporary debug aid: log the exact concatenated source string so a real
        // failing callback reveals which field/casing/order is off (5.8). Remove
        // once Paymob callbacks are confirmed validating in production.
        fastify.log.warn({
          event: 'paymob_hmac_invalid',
          order_id: ourOrderId,
          hmac_source: source,
          received_hmac: String(receivedHmac).slice(0, 16) + '…',
        });
        return reply.status(401).send({ error: 'invalid_signature' });
      }

      // Signature is valid past this point.
      if (!order) {
        fastify.log.warn({ event: 'paymob_webhook_order_not_found', merchant_order_id: ourOrderId });
        return reply.status(200).send({ ok: true }); // ack so Paymob stops retrying
      }

      // --- Idempotency: key on payment_status, not on payment_ref (5.8). ---
      if (order.payment_status === 'PAID') {
        fastify.log.info({ event: 'paymob_webhook_duplicate_ignored', order_id: order.id });
        return reply.status(200).send({ ok: true });
      }

      const txId = field(obj, 'id');
      const success = isTrue(field(obj, 'success'));
      const voided = isTrue(field(obj, 'is_voided'));
      const refunded = isTrue(field(obj, 'is_refunded'));
      const paid = success && !voided && !refunded;

      // Sanity: charged amount must equal the total we recorded (5.8). Log, don't block —
      // the HMAC already proves authenticity.
      const amountCents = Number(field(obj, 'amount_cents'));
      if (Number.isFinite(amountCents) && amountCents !== order.total) {
        fastify.log.warn({ event: 'paymob_amount_mismatch', order_id: order.id, expected: order.total, got: amountCents });
      }

      if (!paid) {
        // Verified failure/decline: leave stock reserved until the TTL sweep
        // EXPIRES the order (5.7). Acknowledge so Paymob stops retrying.
        fastify.log.info({ event: 'paymob_payment_failed', order_id: order.id, success, voided, refunded });
        return reply.status(200).send({ ok: true });
      }

      const items = (Array.isArray(order.items) ? order.items : []) as OrderItemSnapshot[];
      const paymentRef = txId != null ? String(txId) : null;

      // --- Verified success. EXACT sequence (locked, single transaction):
      //     PAID + paid_at + payment_ref → commit stock → status CONFIRMED. ---
      try {
        await prisma.$transaction(async (tx) => {
          // Lock the order row first (consistent lock order: Order then MenuItem).
          const rows = await tx.$queryRaw<Array<{ id: string; payment_status: string }>>`
            SELECT id, payment_status FROM "Order" WHERE id = ${order.id} FOR UPDATE
          `;
          if (rows.length === 0) throw new Error('order_vanished');
          // Re-check idempotency inside the lock — guards against concurrent duplicates.
          if (rows[0].payment_status === 'PAID') {
            fastify.log.info({ event: 'paymob_webhook_duplicate_ignored_locked', order_id: order.id });
            return;
          }

          await tx.order.update({
            where: { id: order.id },
            data: { payment_status: 'PAID', paid_at: new Date(), payment_ref: paymentRef },
          });

          await commitStock(tx, order.venue_id, items.map((i) => ({ sku: i.sku, qty: i.qty })));

          await tx.order.update({
            where: { id: order.id },
            data: { status: 'CONFIRMED' },
          });
        });
      } catch (err) {
        fastify.log.error({ event: 'paymob_confirm_failed', order_id: order.id, error: String(err) });
        // Confirmation failed before commit — return 500 so Paymob retries.
        return reply.status(500).send({ error: 'confirm_failed' });
      }

      fastify.log.info({ event: 'order_confirmed', order_id: order.id, venue_id: order.venue_id, status: 'CONFIRMED', payment_ref: paymentRef });

      // --- Route OUTSIDE the transaction. If routing fails, the stock commit and
      //     CONFIRMED state STAND — do not roll back (per session brief / 5.4). ---
      const canonical: CanonicalOrder = {
        id: order.id,
        venue_id: order.venue_id,
        table: order.table_label,
        customer_name: order.customer_name ?? undefined,
        payment_method: order.payment_method as 'CARD' | 'APPLE_PAY',
        payment_status: 'PAID',
        items,
        total: order.total,
        paid_at: new Date().toISOString(),
        payment_ref: paymentRef ?? undefined,
      };

      try {
        await routeOrder(canonical, order.venue_id, order.venue.pos_type);
      } catch (err) {
        fastify.log.error({ event: 'route_order_failed', order_id: order.id, error: String(err) });
      }

      return reply.status(200).send({ ok: true });
    },
  );
}
