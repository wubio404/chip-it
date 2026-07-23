import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/db.js';
import { config } from '../lib/config.js';
import { reserveStock, commitStock, releaseReservation } from '../services/inventory.js';
import { routeOrder } from '../connectors/router.js';
import { getPaymobConfig, createIntention, buildCheckoutUrl } from '../lib/paymob.js';
import { emitOrderById } from '../lib/order-events.js';
import type { CanonicalOrder } from '@taporder/types';

interface CreateOrderBody {
  venue_slug: string;
  table_nfc_slug: string;
  customer_name?: string;
  customer_phone?: string;
  payment_method: 'CASH' | 'CARD' | 'APPLE_PAY';
  items: Array<{ sku: string; qty: number }>;
}

interface OrderParams {
  id: string;
}

interface CancelBody {
  reason?: string;
}

// Tagged error helper for structured throws inside transactions
function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

export async function orderRoutes(fastify: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // POST /orders — create and auto-confirm a cash order
  // ---------------------------------------------------------------------------
  fastify.post<{ Body: CreateOrderBody }>(
    '/orders',
    {
      // Section 11: 10 req/min per IP (prevents cart spam).
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['venue_slug', 'table_nfc_slug', 'payment_method', 'items'],
          properties: {
            venue_slug:      { type: 'string', minLength: 1, maxLength: 100 },
            table_nfc_slug:  { type: 'string', minLength: 1, maxLength: 50 },
            customer_name:   { type: 'string', maxLength: 100 },
            customer_phone:  { type: 'string', maxLength: 30 },
            payment_method:  { type: 'string', enum: ['CASH', 'CARD', 'APPLE_PAY'] },
            items: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                required: ['sku', 'qty'],
                properties: {
                  sku: { type: 'string', minLength: 1 },
                  qty: { type: 'integer', minimum: 1, maximum: 99 },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { venue_slug, table_nfc_slug, customer_name, customer_phone, payment_method, items } = request.body;

      // 1. Resolve venue
      const venue = await prisma.venue.findUnique({
        where: { slug: venue_slug },
        select: { id: true, slug: true, pos_type: true, active: true },
      });
      if (!venue || !venue.active) {
        return reply.status(404).send({ error: 'venue_not_found' });
      }

      // 2. Resolve table (nfc_slug is globally unique; verify it belongs to this venue)
      const table = await prisma.table.findUnique({ where: { nfc_slug: table_nfc_slug } });
      if (!table || table.venue_id !== venue.id) {
        return reply.status(404).send({ error: 'table_not_found' });
      }

      // 3. Validate items against the venue's menu (pre-lock, advisory check)
      const skus = items.map((i) => i.sku);
      const menuItems = await prisma.menuItem.findMany({
        where: { venue_id: venue.id, sku: { in: skus } },
        select: { id: true, sku: true, pos_sku: true, name: true, price: true, available: true },
      });

      if (menuItems.length !== skus.length) {
        const found = new Set(menuItems.map((m) => m.sku));
        const missing = skus.filter((s) => !found.has(s));
        return reply.status(422).send({ error: 'items_not_found', skus: missing });
      }

      const unavailable = menuItems.filter((m) => !m.available);
      if (unavailable.length > 0) {
        return reply.status(422).send({ error: 'items_unavailable', skus: unavailable.map((m) => m.sku) });
      }

      // Build the order item snapshot — prices captured at order time (tax-inclusive, piastres)
      const orderItems = items.map(({ sku, qty }) => {
        const mi = menuItems.find((m) => m.sku === sku)!;
        return {
          sku: mi.sku,
          pos_sku: mi.pos_sku ?? undefined,
          name: mi.name,
          qty,
          unit_price: mi.price,
        };
      });
      const total = orderItems.reduce((sum, i) => sum + i.unit_price * i.qty, 0);
      const inventoryItems = items.map(({ sku, qty }) => ({ sku, qty }));

      // =======================================================================
      // ONLINE PATH (CARD / APPLE_PAY) — Section 5.8 online flow + Appendix A.
      // Card and Apple Pay share ONE Paymob intention; no separate code path.
      // Stock is reserved but NOT committed and the order is NOT confirmed here —
      // that happens only on the verified paid webhook (5.8 step 7).
      // =======================================================================
      if (payment_method === 'CARD' || payment_method === 'APPLE_PAY') {
        if (!config.appBaseUrl || !config.apiBaseUrl) {
          fastify.log.error({ event: 'payment_not_configured', missing: 'APP_BASE_URL/API_BASE_URL' });
          return reply.status(500).send({ error: 'payment_not_configured' });
        }

        let paymobCfg;
        try {
          paymobCfg = getPaymobConfig(venue);
        } catch (err) {
          fastify.log.error({ event: 'paymob_config_error', error: String(err) });
          return reply.status(500).send({ error: 'payment_not_configured' });
        }

        // 1. Reserve stock + create the order (CREATED, UNPAID). No commit, no confirm.
        let created: { id: string };
        try {
          created = await prisma.$transaction(async (tx) => {
            await reserveStock(tx, venue.id, inventoryItems);
            return tx.order.create({
              data: {
                venue_id: venue.id,
                table_label: table.label,
                customer_name: customer_name ?? null,
                customer_phone: customer_phone ?? null,
                items: orderItems,
                total,
                status: 'CREATED',
                payment_method,
                payment_status: 'UNPAID',
              },
              select: { id: true },
            });
          });
        } catch (err: unknown) {
          const e = err as Error & { sku?: string; available?: number };
          if (e.message === 'item_not_found')     return reply.status(422).send({ error: 'item_not_found', sku: e.sku });
          if (e.message === 'item_unavailable')   return reply.status(422).send({ error: 'item_unavailable', sku: e.sku });
          if (e.message === 'insufficient_stock') return reply.status(422).send({ error: 'insufficient_stock', sku: e.sku, available: e.available });
          throw err;
        }

        fastify.log.info({ event: 'order_created', order_id: created.id, venue_id: venue.id, table: table.label, status: 'CREATED', payment_method });
        await emitOrderById(created.id);

        // 2. Create the Paymob intention. amount + items[].amount are piastres;
        //    sum(items.amount * quantity) must equal amount (Paymob rejects a mismatch).
        let checkoutUrl: string;
        try {
          const intention = await createIntention({
            cfg: paymobCfg,
            amount: total,
            items: orderItems.map((i) => ({
              name: i.name,
              amount: i.unit_price,
              quantity: i.qty,
              description: i.name,
            })),
            orderId: created.id,
            venueId: venue.id,
            tableLabel: table.label,
            customerName: customer_name,
            customerPhone: customer_phone,
            notificationUrl: `${config.apiBaseUrl.replace(/\/$/, '')}/webhooks/paymob`,
            // Carry our order id in the PATH, not a query key. Gateways append their
            // own params (Paymob even clobbers a `?order=` key with its intention id),
            // but none rewrite the path — so the confirm page reads OUR id the same way
            // regardless of gateway. Keeps the redirect portable on a Paymob migration;
            // `merchant_order_id` (Paymob-specific) is only a fallback. The webhook
            // (special_reference → our id) remains the real source of truth either way.
            redirectionUrl: `${config.appBaseUrl.replace(/\/$/, '')}/order/confirm/${created.id}`,
          });
          checkoutUrl = buildCheckoutUrl(paymobCfg.publicKey, intention.clientSecret);
        } catch (err) {
          // Intention failed — release the reservation immediately rather than
          // holding stock until the TTL sweep. Compensating, order-locked tx.
          fastify.log.error({ event: 'paymob_intention_error', order_id: created.id, error: String(err) });
          try {
            await prisma.$transaction(async (tx) => {
              const rows = await tx.$queryRaw<Array<{ id: string; venue_id: string; status: string; items: Array<{ sku: string; qty: number }> }>>`
                SELECT id, venue_id, status, items FROM "Order" WHERE id = ${created.id} FOR UPDATE
              `;
              if (rows.length === 0 || rows[0].status !== 'CREATED') return;
              const o = rows[0];
              const its = (Array.isArray(o.items) ? o.items : []) as Array<{ sku: string; qty: number }>;
              await releaseReservation(tx, o.venue_id, its.map((i) => ({ sku: i.sku, qty: i.qty })));
              await tx.order.update({ where: { id: created.id }, data: { status: 'EXPIRED' } });
            });
            await emitOrderById(created.id);
          } catch (cErr) {
            fastify.log.error({ event: 'paymob_intention_compensation_failed', order_id: created.id, error: String(cErr) });
          }
          return reply.status(502).send({ error: 'payment_init_failed' });
        }

        // 3. Move to PAYMENT_PENDING — checkout shown, awaiting payment (5.2).
        await prisma.order.update({ where: { id: created.id }, data: { status: 'PAYMENT_PENDING' } });
        fastify.log.info({ event: 'order_payment_pending', order_id: created.id, venue_id: venue.id, status: 'PAYMENT_PENDING' });
        await emitOrderById(created.id);

        return reply.status(201).send({ order_id: created.id, checkout_url: checkoutUrl });
      }

      // =======================================================================
      // CASH PATH (unchanged) — auto-confirm and commit stock immediately.
      // =======================================================================
      // 4. Single transaction: reserve → CREATED → commit → CONFIRMED
      let order: { id: string; status: string; payment_status: string; routing_tier: string | null };
      try {
        order = await prisma.$transaction(async (tx) => {
          // Acquire row-level locks and reserve stock
          await reserveStock(tx, venue.id, inventoryItems);

          const created = await tx.order.create({
            data: {
              venue_id: venue.id,
              table_label: table.label,
              customer_name: customer_name ?? null,
              customer_phone: customer_phone ?? null,
              items: orderItems,
              total,
              status: 'CREATED',
              payment_method: 'CASH',
              payment_status: 'UNPAID',
            },
            select: { id: true, status: true, payment_status: true, routing_tier: true },
          });

          fastify.log.info({ event: 'order_created', order_id: created.id, venue_id: venue.id, table: table.label, status: 'CREATED' });

          // Commit: sale is now real — stock_count decrements
          await commitStock(tx, venue.id, inventoryItems);

          const confirmed = await tx.order.update({
            where: { id: created.id },
            data: { status: 'CONFIRMED' },
            select: { id: true, status: true, payment_status: true, routing_tier: true },
          });

          fastify.log.info({ event: 'order_confirmed', order_id: confirmed.id, venue_id: venue.id, status: 'CONFIRMED' });

          return confirmed;
        });
      } catch (err: unknown) {
        const e = err as Error & { sku?: string; available?: number };
        if (e.message === 'item_not_found')    return reply.status(422).send({ error: 'item_not_found', sku: e.sku });
        if (e.message === 'item_unavailable')  return reply.status(422).send({ error: 'item_unavailable', sku: e.sku });
        if (e.message === 'insufficient_stock') return reply.status(422).send({ error: 'insufficient_stock', sku: e.sku, available: e.available });
        throw err;
      }

      await emitOrderById(order.id);

      // 5. Route outside the transaction — routing can be slow and its failure is non-fatal
      const canonical: CanonicalOrder = {
        id: order.id,
        venue_id: venue.id,
        table: table.label,
        customer_name,
        payment_method: 'CASH',
        payment_status: 'UNPAID',
        items: orderItems,
        total,
      };

      try {
        await routeOrder(canonical, venue.id, venue.pos_type);
      } catch (err) {
        fastify.log.error({ event: 'route_order_failed', order_id: order.id, error: String(err) });
      }

      // Return fresh state (routing may have updated routing_tier)
      const final = await prisma.order.findUnique({
        where: { id: order.id },
        select: { id: true, status: true, payment_status: true, routing_tier: true, table_label: true, total: true },
      });

      return reply.status(201).send(final);
    },
  );

  // ---------------------------------------------------------------------------
  // GET /orders/:id/status — poll for order state
  // ---------------------------------------------------------------------------
  fastify.get<{ Params: OrderParams }>(
    '/orders/:id/status',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      const order = await prisma.order.findUnique({
        where: { id: request.params.id },
        select: { id: true, status: true, payment_status: true, routing_tier: true },
      });
      if (!order) return reply.status(404).send({ error: 'order_not_found' });
      return reply.send(order);
    },
  );

  // ---------------------------------------------------------------------------
  // POST /orders/:id/cancel — customer cancel; only allowed while CREATED
  // ---------------------------------------------------------------------------
  fastify.post<{ Params: OrderParams; Body: CancelBody }>(
    '/orders/:id/cancel',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', minLength: 1 } },
        },
        body: {
          type: 'object',
          properties: { reason: { type: 'string', maxLength: 500 } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const reason = request.body?.reason ?? null;

      try {
        await prisma.$transaction(async (tx) => {
          // Lock the order row first — consistent lock order (Order then MenuItem)
          const rows = await tx.$queryRaw<Array<{
            id: string;
            venue_id: string;
            status: string;
            items: Array<{ sku: string; qty: number }>;
          }>>`
            SELECT id, venue_id, status, items
            FROM "Order"
            WHERE id = ${id}
            FOR UPDATE
          `;

          if (rows.length === 0) throw httpError(404, 'order_not_found');

          const order = rows[0];

          // Spec 5.9: customer may cancel before CONFIRMED — CREATED or PAYMENT_PENDING.
          // Enforced inside the lock to prevent races with the Paymob webhook.
          if (order.status !== 'CREATED' && order.status !== 'PAYMENT_PENDING') throw httpError(409, 'cancel_not_allowed');

          const items = (Array.isArray(order.items) ? order.items : []) as Array<{ sku: string; qty: number }>;

          await releaseReservation(tx, order.venue_id, items.map((i) => ({ sku: i.sku, qty: i.qty })));

          await tx.order.update({
            where: { id },
            data: { status: 'CANCELLED', cancel_reason: reason },
          });
        });

        fastify.log.info({ event: 'order_cancelled', order_id: id });
        await emitOrderById(id);
        return reply.send({ ok: true });
      } catch (err: unknown) {
        const e = err as Error & { statusCode?: number };
        if (e.statusCode === 404) return reply.status(404).send({ error: 'order_not_found' });
        if (e.statusCode === 409) return reply.status(409).send({ error: 'cancel_not_allowed', message: 'Order can only be cancelled while in CREATED or PAYMENT_PENDING status' });
        throw err;
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Expiry cron — called from index.ts every 60 s
// ---------------------------------------------------------------------------
export async function expireStaleOrders(): Promise<void> {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000);

  // Snapshot candidates without locks — the transaction below re-checks with FOR UPDATE.
  // CREATED covers carts that never started payment; PAYMENT_PENDING covers online
  // orders where the customer never completed the Paymob checkout (5.7).
  const candidates = await prisma.order.findMany({
    where: { status: { in: ['CREATED', 'PAYMENT_PENDING'] }, created_at: { lt: cutoff } },
    select: { id: true },
  });

  for (const { id } of candidates) {
    try {
      await prisma.$transaction(async (tx) => {
        // Lock the order row — guard against racing with a concurrent cancel
        const rows = await tx.$queryRaw<Array<{
          id: string;
          venue_id: string;
          items: Array<{ sku: string; qty: number }>;
        }>>`
          SELECT id, venue_id, items
          FROM "Order"
          WHERE id = ${id} AND status IN ('CREATED', 'PAYMENT_PENDING')
          FOR UPDATE
        `;

        // If status already changed (cancelled by customer, confirmed late), skip silently
        if (rows.length === 0) return;

        const order = rows[0];
        const items = (Array.isArray(order.items) ? order.items : []) as Array<{ sku: string; qty: number }>;

        await releaseReservation(tx, order.venue_id, items.map((i) => ({ sku: i.sku, qty: i.qty })));

        await tx.order.update({
          where: { id },
          data: { status: 'EXPIRED' },
        });
      });

      await emitOrderById(id);
      console.log(JSON.stringify({ level: 'info', event: 'order_expired', order_id: id }));
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', event: 'order_expiry_error', order_id: id, error: String(err) }));
    }
  }
}
