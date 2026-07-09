import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/db.js';
import { redis, checkRateLimit } from '../lib/redis.js';
import { requireAuth, requireVenueMatch } from '../middleware/auth.js';
import { releaseReservation, restockCommitted } from '../services/inventory.js';
import { reverseOrderPayment, PaymobReversalError } from '../services/refunds.js';
import { emitOrderById, onOrderEvent, ORDER_ADMIN_SELECT } from '../lib/order-events.js';
import { startOfDayUTC } from '../lib/timezone.js';
import {
  presignPutObject,
  headObject,
  deleteObject,
  publicUrlForKey,
  keyFromPublicUrl,
  CONTENT_TYPE_EXT,
  MAX_IMAGE_BYTES,
} from '../lib/r2.js';

interface ToggleParams {
  id: string;   // venue id — venue-scoped (requireVenueMatch enforces it matches the staff token)
  sku: string;
}

interface ToggleBody {
  available?: boolean;
}

interface VenueIdParams {
  id: string;
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
  // POST /admin/venues/:id/items/:sku/toggle — set or flip item availability (5.7).
  // Body { available } is optional: if present, SET to that value; if absent, FLIP.
  fastify.post<{ Params: ToggleParams; Body: ToggleBody }>(
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
        body: {
          type: 'object',
          properties: { available: { type: 'boolean' } },
        },
      },
    },
    async (request, reply) => {
      const { id: venueId, sku } = request.params;
      const explicit = request.body?.available;

      // WHERE includes venue_id AND sku — no cross-venue writes even if a staff
      // token were somehow paired with another venue's sku.
      const item = await prisma.menuItem.findFirst({
        where: { venue_id: venueId, sku },
        select: { id: true, available: true, venue: { select: { slug: true } } },
      });
      if (!item) {
        return reply.status(404).send({ error: 'item_not_found' });
      }

      const nextAvailable = explicit ?? !item.available;
      const updated = await prisma.menuItem.update({
        where: { id: item.id },
        data: { available: nextAvailable },
        select: { sku: true, available: true },
      });

      // Invalidate the venue cache immediately so the "sold out" flip is visible
      // without waiting out the 60s TTL (spec Section 12).
      await redis.del(`venue:${item.venue.slug}`).catch(() => {});

      fastify.log.info({ event: 'admin_item_toggle', venue_id: venueId, sku, available: updated.available });
      return reply.send(updated);
    },
  );

  const ORDER_TZ = 'Africa/Cairo';

  // Shared by the JSON list endpoint and the SSE `snapshot` event — one query,
  // one definition of "today" (Section 5.2 order list / this session's Part A.2).
  async function getTodaysOrders(venueId: string) {
    const since = startOfDayUTC(ORDER_TZ);
    return prisma.order.findMany({
      where: { venue_id: venueId, created_at: { gte: since } },
      orderBy: { created_at: 'desc' },
      select: ORDER_ADMIN_SELECT,
    });
  }

  const orderResponseProps = {
    id: { type: 'string' },
    venue_id: { type: 'string' },
    table_label: { type: 'string' },
    customer_name: { type: ['string', 'null'] },
    items: {},
    total: { type: 'integer' },
    status: { type: 'string' },
    payment_method: { type: 'string' },
    payment_status: { type: 'string' },
    payment_ref: { type: ['string', 'null'] },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
    paid_at: { type: ['string', 'null'] },
  } as const;

  // GET /admin/venues/:id/orders — today's orders (venue-local day, Africa/Cairo).
  fastify.get<{ Params: VenueIdParams }>(
    '/admin/venues/:id/orders',
    {
      preHandler: [requireAuth, requireVenueMatch('id')],
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', minLength: 1 } },
        },
        response: {
          200: { type: 'array', items: { type: 'object', properties: orderResponseProps } },
        },
      },
    },
    async (request, reply) => {
      const orders = await getTodaysOrders(request.params.id);
      return reply.send(orders);
    },
  );

  // GET /admin/venues/:id/orders/stream — SSE live order feed (in-process only;
  // Redis pub/sub is the §8 scale-out replacement, not built in this session).
  fastify.get<{ Params: VenueIdParams }>(
    '/admin/venues/:id/orders/stream',
    { preHandler: [requireAuth, requireVenueMatch('id')] },
    async (request, reply) => {
      const venueId = request.params.id;

      // reply.raw.writeHead() below bypasses Fastify's own header queue entirely —
      // including whatever @fastify/cors's onRequest hook already set via reply.header()
      // (access-control-allow-origin, -credentials, Vary). Merge those in explicitly so
      // this route isn't silently CORS-broken relative to every other endpoint.
      reply.raw.writeHead(200, {
        ...(reply.getHeaders() as Record<string, string | number | string[]>),
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      reply.hijack();
      // Nagle's algorithm can hold small writes on a persistent connection waiting
      // to coalesce them — noticeable as multi-hundred-ms lag on a low-traffic SSE
      // stream where each event is its own small chunk. Disable it for this socket.
      reply.raw.socket?.setNoDelay(true);

      const send = (event: string, data: unknown) => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      fastify.log.info({ event: 'admin_sse_connect', venue_id: venueId });

      try {
        send('snapshot', await getTodaysOrders(venueId));
      } catch (err) {
        fastify.log.error({ event: 'admin_sse_snapshot_failed', venue_id: venueId, error: String(err) });
      }

      const unsubscribe = onOrderEvent((order) => {
        if (order.venue_id === venueId) send('order', order);
      });

      // Comment ping every 25s — keeps intermediary proxies (Nginx et al) from
      // timing out the idle connection.
      const keepAlive = setInterval(() => {
        reply.raw.write(':\n\n');
      }, 25_000);

      request.raw.on('close', () => {
        clearInterval(keepAlive);
        unsubscribe();
        fastify.log.info({ event: 'admin_sse_disconnect', venue_id: venueId });
      });
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
    const result = await prisma.$transaction(async (tx) => {
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
    await emitOrderById(orderId);
    return result;
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

        await emitOrderById(orderId);
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

  // ---------------------------------------------------------------------------
  // Menu item image upload (Section 12 / Phase 2 item 4) — presign + confirm.
  // ---------------------------------------------------------------------------

  interface ItemImageParams {
    id: string;   // venue id — venue-scoped
    sku: string;
  }

  const itemImageParamsSchema = {
    type: 'object',
    required: ['id', 'sku'],
    properties: {
      id: { type: 'string', minLength: 1 },
      sku: { type: 'string', minLength: 1 },
    },
  } as const;

  const ALLOWED_IMAGE_TYPES = new Set(Object.keys(CONTENT_TYPE_EXT));

  // Per-user cap on the presign route specifically (stricter than the general
  // /admin/* surface — see lib/redis.ts checkRateLimit note on why this isn't
  // wired through @fastify/rate-limit).
  async function presignRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const userId = request.user!.sub;
    const { allowed, retryAfter } = await checkRateLimit(`ratelimit:image_presign:${userId}`, 15, 60);
    if (!allowed) {
      reply.header('Retry-After', String(retryAfter));
      return reply.status(429).send({ error: 'rate_limit_exceeded', retry_after: retryAfter });
    }
  }

  interface ImagePresignBody {
    content_type: string;
    content_length: number;
  }

  // POST /admin/venues/:id/items/:sku/image/presign — issue a presigned R2 PUT URL.
  // Writes nothing to the database; the object may never actually get uploaded.
  fastify.post<{ Params: ItemImageParams; Body: ImagePresignBody }>(
    '/admin/venues/:id/items/:sku/image/presign',
    {
      preHandler: [requireAuth, requireVenueMatch('id'), presignRateLimit],
      schema: {
        params: itemImageParamsSchema,
        body: {
          type: 'object',
          required: ['content_type', 'content_length'],
          properties: {
            content_type: { type: 'string' },
            content_length: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id: venueId, sku } = request.params;
      const { content_type, content_length } = request.body;

      const ext = CONTENT_TYPE_EXT[content_type];
      if (!ALLOWED_IMAGE_TYPES.has(content_type) || !ext) {
        return reply.status(400).send({
          error: 'unsupported_content_type',
          message: 'Only image/jpeg, image/png, image/webp are accepted',
        });
      }
      if (content_length > MAX_IMAGE_BYTES) {
        return reply.status(400).send({ error: 'file_too_large', message: `Max ${MAX_IMAGE_BYTES} bytes` });
      }

      const item = await prisma.menuItem.findFirst({
        where: { venue_id: venueId, sku },
        select: { id: true },
      });
      if (!item) return reply.status(404).send({ error: 'item_not_found' });

      // venues/<venueId>/items/<sku>/<uuid>.<ext> — the venue-id prefix is what
      // makes cross-venue writes structurally impossible, enforced again at confirm.
      const key = `venues/${venueId}/items/${sku}/${randomUUID()}.${ext}`;

      let uploadUrl: string;
      try {
        uploadUrl = await presignPutObject(key, content_type, content_length);
      } catch (err) {
        fastify.log.error({ event: 'image_presign_failed', venue_id: venueId, sku, error: String(err) });
        return reply.status(500).send({
          error: 'r2_not_configured',
          message: 'R2 credentials are missing from the API server environment',
        });
      }

      fastify.log.info({
        event: 'image_presign_issued',
        venue_id: venueId,
        sku,
        key,
        content_type,
        content_length,
      });

      return reply.send({ upload_url: uploadUrl, key, public_url: publicUrlForKey(key) });
    },
  );

  interface ImageConfirmBody {
    key: string;
  }

  // POST /admin/venues/:id/items/:sku/image/confirm — verify the object actually
  // exists in R2, then persist menu_items.image_url and invalidate the venue cache.
  fastify.post<{ Params: ItemImageParams; Body: ImageConfirmBody }>(
    '/admin/venues/:id/items/:sku/image/confirm',
    {
      preHandler: [requireAuth, requireVenueMatch('id')],
      schema: {
        params: itemImageParamsSchema,
        body: {
          type: 'object',
          required: ['key'],
          properties: { key: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      const { id: venueId, sku } = request.params;
      const { key } = request.body;

      // Never trust a client-supplied key blindly — it must live under THIS
      // venue's and THIS item's own prefix.
      const expectedPrefix = `venues/${venueId}/items/${sku}/`;
      if (!key.startsWith(expectedPrefix)) {
        fastify.log.warn({ event: 'image_confirm_key_mismatch', venue_id: venueId, sku, key });
        return reply.status(403).send({ error: 'key_prefix_mismatch' });
      }

      const item = await prisma.menuItem.findFirst({
        where: { venue_id: venueId, sku },
        select: { id: true, image_url: true, venue: { select: { slug: true } } },
      });
      if (!item) return reply.status(404).send({ error: 'item_not_found' });

      let head: { contentLength: number; contentType: string | null } | null;
      try {
        head = await headObject(key);
      } catch (err) {
        fastify.log.error({ event: 'image_confirm_head_failed', venue_id: venueId, sku, key, error: String(err) });
        return reply.status(500).send({ error: 'r2_error' });
      }
      if (!head) {
        // Upload never landed (failed PUT, wrong bucket, etc.) — persist nothing.
        return reply.status(409).send({ error: 'object_not_found', message: 'Upload was not found in R2 — retry the upload' });
      }

      // Backstop size check: the presign step already binds ContentLength into the
      // signature (see lib/r2.ts), so this should only trip on a tampered/unusual
      // client. Delete the oversized object and reject rather than persist it.
      if (head.contentLength > MAX_IMAGE_BYTES) {
        await deleteObject(key).catch((err) => {
          fastify.log.warn({ event: 'image_oversize_cleanup_failed', venue_id: venueId, sku, key, error: String(err) });
        });
        return reply.status(413).send({ error: 'file_too_large' });
      }

      // Real content-type enforcement point: S3/R2 presigned PUT URLs cannot bind
      // Content-Type into the signature (the AWS SDK hardcodes it as unsignable —
      // see lib/r2.ts), so a PUT could have stored the object under ANY declared
      // type regardless of what was requested at presign time. Check what actually
      // landed and reject anything outside the allowed image types before ever
      // persisting a URL to it.
      if (!head.contentType || !ALLOWED_IMAGE_TYPES.has(head.contentType)) {
        await deleteObject(key).catch((err) => {
          fastify.log.warn({ event: 'image_bad_content_type_cleanup_failed', venue_id: venueId, sku, key, error: String(err) });
        });
        fastify.log.warn({ event: 'image_confirm_content_type_rejected', venue_id: venueId, sku, key, content_type: head.contentType });
        return reply.status(415).send({ error: 'unexpected_content_type' });
      }

      const publicUrl = publicUrlForKey(key);
      const previousUrl = item.image_url;

      const updated = await prisma.menuItem.update({
        where: { id: item.id },
        data: { image_url: publicUrl },
        select: { sku: true, image_url: true },
      });

      await redis.del(`venue:${item.venue.slug}`).catch(() => {});

      fastify.log.info({ event: 'image_confirmed', venue_id: venueId, sku, key, public_url: publicUrl });

      // Best-effort cleanup of the item's previous image, only if it lived under
      // this item's own prefix — never delete something outside that namespace.
      if (previousUrl && previousUrl !== publicUrl) {
        const oldKey = keyFromPublicUrl(previousUrl);
        if (oldKey && oldKey.startsWith(expectedPrefix)) {
          deleteObject(oldKey).catch((err) => {
            fastify.log.warn({ event: 'old_image_delete_failed', venue_id: venueId, sku, key: oldKey, error: String(err) });
          });
        }
      }

      return reply.send(updated);
    },
  );
}
