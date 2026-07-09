import { prisma } from '../lib/db.js';
import {
  getPaymobConfig,
  reversePaymobTransaction,
  PaymobReversalError,
  type PaymobLogger,
  type ReversalMode,
} from '../lib/paymob.js';
import { restockCommitted } from './inventory.js';
import { emitOrderById } from '../lib/order-events.js';

// ---------------------------------------------------------------------------
// The reversal client — the SINGLE place that un-pays an order (Section 5.9).
//
// One function, called by every trigger (staff cancel, paid_after_cancel sweep,
// FAILED-routing auto-refund). It owns money reversal + payment_status + refund_ref
// + restock, all inside ONE order-locked transaction so it is safe to re-run.
//
// It deliberately does NOT decide policy (who may cancel, when). Callers gate that;
// this function only performs the reversal for an order that should be reversed.
// ---------------------------------------------------------------------------

// Console-JSON fallback so the router (which has no Fastify instance) can call in
// the same structured style it already uses. Route handlers pass fastify.log.
const consoleLogger: PaymobLogger = {
  info: (o) => console.log(JSON.stringify({ level: 'info', ...o })),
  warn: (o) => console.error(JSON.stringify({ level: 'warn', ...o })),
  error: (o) => console.error(JSON.stringify({ level: 'error', ...o })),
};

export type ReversalTrigger = 'staff_cancel' | 'failed_routing' | 'paid_after_cancel_sweep';

export interface ReverseOpts {
  trigger: ReversalTrigger;
  // When provided (staff cancel), the order's fulfillment status is set to this in
  // the SAME transaction as the reversal, so money + status flip atomically. Omit
  // for the sweep (leave CANCELLED/EXPIRED) and FAILED (leave FAILED).
  finalStatus?: 'CANCELLED';
  cancelReason?: string | null;
  log?: PaymobLogger;
}

export type ReverseOutcome =
  | { ok: true; mode: ReversalMode; reversalId: string; alreadyReversed: boolean; restocked: boolean }
  | { ok: false; reason: 'not_found' | 'not_paid' | 'cash_no_reversal' | 'no_transaction_ref' | 'not_cancellable' };

interface OrderRow {
  id: string;
  venue_id: string;
  status: string;
  payment_status: string;
  payment_method: string;
  payment_ref: string | null;
  refund_ref: string | null;
  total: number;
  items: Array<{ sku: string; qty: number }>;
}

// Reverse an order's payment. Idempotent: an already VOIDED/REFUNDED order returns
// its existing result and performs no second Paymob call.
//
// IMPORTANT: the Paymob HTTP call happens INSIDE the order-locked transaction (per
// session brief) so the payment_status re-check and the reversal cannot interleave
// with a concurrent trigger. The transaction timeout is widened to accommodate the
// external call. If Paymob succeeds but the surrounding DB write later fails, the
// reversal id was already logged (paymob_reversal_ok) for manual reconciliation.
export async function reverseOrderPayment(orderId: string, opts: ReverseOpts): Promise<ReverseOutcome> {
  const log = opts.log ?? consoleLogger;

  const outcome = await prisma.$transaction<ReverseOutcome>(
    async (tx) => {
      const rows = await tx.$queryRaw<OrderRow[]>`
        SELECT id, venue_id, status, payment_status, payment_method,
               payment_ref, refund_ref, total, items
        FROM "Order"
        WHERE id = ${orderId}
        FOR UPDATE
      `;
      if (rows.length === 0) return { ok: false, reason: 'not_found' } as const;
      const order = rows[0];

      // --- Idempotency (re-checked inside the lock): never reverse twice. ---
      if (order.payment_status === 'VOIDED' || order.payment_status === 'REFUNDED') {
        const mode: ReversalMode = order.payment_status === 'VOIDED' ? 'void' : 'refund';
        log.info({ event: 'reversal_skip_already_reversed', order_id: orderId, payment_status: order.payment_status, trigger: opts.trigger });
        // Still honour a cancel request's status flip if it hasn't happened yet.
        if (opts.finalStatus && order.status !== opts.finalStatus && order.status !== 'FULFILLED') {
          await tx.order.update({ where: { id: orderId }, data: { status: opts.finalStatus, cancel_reason: opts.cancelReason ?? undefined } });
        }
        return { ok: true, mode, reversalId: order.refund_ref ?? '', alreadyReversed: true, restocked: false };
      }

      if (order.payment_status !== 'PAID') return { ok: false, reason: 'not_paid' } as const;

      // Cash has no Paymob transaction to reverse (5.9). Caller handles cash separately.
      if (order.payment_method === 'CASH') return { ok: false, reason: 'cash_no_reversal' } as const;

      // Cancel context: a FULFILLED order is past the point of cancellation (5.9).
      if (opts.finalStatus === 'CANCELLED' && order.status === 'FULFILLED') {
        return { ok: false, reason: 'not_cancellable' } as const;
      }

      if (!order.payment_ref) {
        // Paid online but no stored transaction id — can't call Paymob. Flag, don't flip.
        log.error({ event: 'reversal_no_transaction_ref', order_id: orderId, trigger: opts.trigger });
        return { ok: false, reason: 'no_transaction_ref' } as const;
      }

      // Whether stock was ever committed. paid_after_cancel orders (CANCELLED/EXPIRED
      // + PAID) had their reservation RELEASED at cancel time and never committed, so
      // they must NOT be restocked (that would fabricate inventory). Every other
      // reversible state (CONFIRMED/ROUTING/INJECTED/PRINTED/FAILED) committed stock.
      const stockWasCommitted = order.status !== 'CANCELLED' && order.status !== 'EXPIRED';

      const cfg = getPaymobConfig({ id: order.venue_id });

      // Paymob call (auth → void → refund). Throws PaymobReversalError iff both fail;
      // that rolls back this tx, leaving payment_status PAID (flagged for retry).
      const result = await reversePaymobTransaction({
        apiKey: cfg.apiKey,
        transactionId: order.payment_ref,
        amountCents: order.total,
        orderId,
        venueId: order.venue_id,
        log,
      });

      const newPaymentStatus = result.mode === 'void' ? 'VOIDED' : 'REFUNDED';

      await tx.order.update({
        where: { id: orderId },
        data: {
          payment_status: newPaymentStatus,
          refund_ref: result.reversalId,
          ...(opts.finalStatus ? { status: opts.finalStatus, cancel_reason: opts.cancelReason ?? undefined } : {}),
        },
      });

      if (stockWasCommitted) {
        const items = (Array.isArray(order.items) ? order.items : []).map((i) => ({ sku: i.sku, qty: i.qty }));
        await restockCommitted(tx, order.venue_id, items);
      }

      log.info({
        event: 'order_reversed',
        order_id: orderId,
        venue_id: order.venue_id,
        trigger: opts.trigger,
        mode: result.mode,
        reversal_id: result.reversalId,
        payment_status: newPaymentStatus,
        restocked: stockWasCommitted,
      });

      return { ok: true, mode: result.mode, reversalId: result.reversalId, alreadyReversed: false, restocked: stockWasCommitted };
    },
    // External HTTP happens inside — widen the default 5s interactive-tx timeout.
    { timeout: 25_000, maxWait: 8_000 },
  );

  // Emit AFTER commit (never inside the tx). Only on an actual mutation — a
  // not_found/not_paid/etc. outcome touched nothing, so there is nothing to emit.
  if (outcome.ok) await emitOrderById(orderId);

  return outcome;
}

export { PaymobReversalError };
