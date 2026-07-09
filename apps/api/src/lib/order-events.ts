import { EventEmitter } from 'node:events';
import { prisma } from './db.js';

// ---------------------------------------------------------------------------
// In-process order-event emitter for the venue staff admin panel's live feed
// (SSE, Section 5.2 / this session's Part A.1). Every admin SSE connection
// subscribes here and filters by venue_id.
//
// Single-process only: if the API ever runs as more than one instance, an
// order routed by instance A won't reach an SSE client connected to instance
// B. Redis pub/sub (Section 8) is the documented scale-out replacement —
// deliberately not built now (out of scope for this session).
// ---------------------------------------------------------------------------

export interface OrderEventPayload {
  id: string;
  venue_id: string;
  table_label: string;
  customer_name: string | null;
  items: unknown;
  total: number;
  status: string;
  payment_method: string;
  payment_status: string;
  payment_ref: string | null;
  created_at: Date;
  updated_at: Date;
  paid_at: Date | null;
  // Diagnostic only (latency investigation) — ISO timestamp of the moment this
  // process emitted the event, NOT a DB column. Only present on live 'order'
  // events (emitOrderById), never on a snapshot read.
  _emitted_at: string;
}

// Shared Prisma select — the single source of truth for the row shape sent to
// both the admin JSON list endpoint and every SSE event.
export const ORDER_ADMIN_SELECT = {
  id: true,
  venue_id: true,
  table_label: true,
  customer_name: true,
  items: true,
  total: true,
  status: true,
  payment_method: true,
  payment_status: true,
  payment_ref: true,
  created_at: true,
  updated_at: true,
  paid_at: true,
} as const;

const emitter = new EventEmitter();
// Many admin SSE connections (one per logged-in staff browser tab) may subscribe.
emitter.setMaxListeners(200);

const EVENT_NAME = 'order';

export function onOrderEvent(cb: (payload: OrderEventPayload) => void): () => void {
  emitter.on(EVENT_NAME, cb);
  return () => emitter.off(EVENT_NAME, cb);
}

function emitOrderEvent(payload: OrderEventPayload): void {
  emitter.emit(EVENT_NAME, payload);
}

// Re-reads the order AFTER its owning transaction has committed and emits it.
// Never call this from inside a transaction — the read must see committed data.
// Best-effort: a read failure here must never fail the caller's request.
export async function emitOrderById(orderId: string): Promise<void> {
  try {
    const order = await prisma.order.findUnique({ where: { id: orderId }, select: ORDER_ADMIN_SELECT });
    if (order) {
      const emittedAt = new Date().toISOString();
      emitOrderEvent({ ...order, _emitted_at: emittedAt });
      console.log(JSON.stringify({ level: 'info', event: 'order_event_emitted', order_id: orderId, status: order.status, emitted_at: emittedAt }));
    }
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', event: 'order_event_emit_failed', order_id: orderId, error: String(err) }));
  }
}
