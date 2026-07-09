'use client';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatEGP } from '@/lib/money';
import { cancelOrderAdmin, collectOrderAdmin } from '@/lib/api';
import type { AdminOrder } from '@/lib/api';

// After any of these the order can no longer be cancelled or collected against.
const TERMINAL = new Set(['FULFILLED', 'CANCELLED', 'FAILED', 'EXPIRED']);

// Safety net: if SSE/poll never confirms the action (shouldn't happen, but don't
// lock the buttons forever if it doesn't), release the pending gate after this.
const PENDING_TIMEOUT_MS = 15_000;

interface Props {
  order: AdminOrder;
  venueId: string;
  onToast: (message: string) => void;
}

export function OrderCard({ order, venueId, onToast }: Props) {
  const t = useTranslations();
  const [busy, setBusy] = useState<'cancel' | 'collect' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The request can succeed well before the row's own `order` prop reflects the
  // new state (that only happens once SSE — or the safety-net poll — delivers
  // it). Without this gate, the button re-enables the instant the HTTP response
  // lands, against still-stale `order.status` — exactly what let staff click
  // Cancel twice. Keep it disabled (still showing the busy label) until the
  // prop actually changes, never by mutating status locally.
  const [pending, setPending] = useState<{ action: 'cancel' | 'collect'; sinceUpdatedAt: string } | null>(null);

  useEffect(() => {
    if (pending !== null && order.updated_at !== pending.sinceUpdatedAt) {
      setPending(null);
    }
  }, [order.updated_at, pending]);

  useEffect(() => {
    if (pending === null) return;
    const timer = setTimeout(() => setPending(null), PENDING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  const locked = busy !== null || pending !== null;
  const activeAction = busy ?? pending?.action ?? null;
  // Status-only: whether the button appears at all. Once SSE/poll confirms the
  // terminal status, this goes false and the button disappears for good.
  const showCancel = !TERMINAL.has(order.status);
  const showCollect = order.payment_method === 'CASH' && order.payment_status === 'UNPAID' && !TERMINAL.has(order.status);

  async function handleCancel() {
    if (typeof window !== 'undefined' && !window.confirm(t('admin.orders.confirm_cancel'))) return;
    setBusy('cancel');
    setError(null);
    try {
      // The row itself updates via the SSE `order` event, not from this response.
      await cancelOrderAdmin(venueId, order.id);
      setPending({ action: 'cancel', sinceUpdatedAt: order.updated_at });
      onToast(t('admin.orders.cancel_success'));
    } catch (err) {
      setError((err as Error).message ?? 'error');
    } finally {
      setBusy(null);
    }
  }

  async function handleCollect() {
    setBusy('collect');
    setError(null);
    try {
      await collectOrderAdmin(venueId, order.id);
      setPending({ action: 'collect', sinceUpdatedAt: order.updated_at });
      onToast(t('admin.orders.collect_success'));
    } catch (err) {
      setError((err as Error).message ?? 'error');
    } finally {
      setBusy(null);
    }
  }

  const shortId = order.id.slice(-6).toUpperCase();
  const time = new Date(order.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <p className="text-lg font-bold text-gray-900 leading-tight">{order.table_label}</p>
          <p className="text-xs text-gray-400 font-mono">
            #{shortId} · {time}
          </p>
          {order.customer_name && <p className="text-sm text-gray-600 truncate">{order.customer_name}</p>}
        </div>
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <StatusBadge status={order.status} />
          <PaymentBadge method={order.payment_method} status={order.payment_status} />
        </div>
      </div>

      <ul className="text-sm text-gray-700 mb-2 space-y-0.5">
        {order.items.map((it, i) => (
          <li key={`${it.sku}-${i}`}>
            {it.qty}× {it.name}
          </li>
        ))}
      </ul>

      <div className="flex items-center justify-between border-t border-gray-100 pt-2 gap-2">
        <span className="font-bold text-gray-900 tabular-nums">{formatEGP(order.total)}</span>
        <div className="flex gap-2">
          {showCollect && (
            <button
              onClick={handleCollect}
              disabled={locked}
              className="text-xs font-semibold px-3 py-1.5 rounded-full bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
            >
              {activeAction === 'collect' ? t('admin.orders.collecting') : t('admin.orders.mark_collected')}
            </button>
          )}
          {showCancel && (
            <button
              onClick={handleCancel}
              disabled={locked}
              className="text-xs font-semibold px-3 py-1.5 rounded-full bg-red-50 text-red-600 hover:bg-red-100 disabled:opacity-50"
            >
              {activeAction === 'cancel' ? t('admin.orders.cancelling') : t('admin.orders.cancel')}
            </button>
          )}
        </div>
      </div>

      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
    </div>
  );
}

const STATUS_COLORS: Record<string, string> = {
  CREATED: 'bg-gray-100 text-gray-600',
  PAYMENT_PENDING: 'bg-amber-50 text-amber-700',
  CONFIRMED: 'bg-blue-50 text-blue-700',
  ROUTING: 'bg-blue-50 text-blue-700',
  INJECTED: 'bg-blue-50 text-blue-700',
  PRINTED: 'bg-blue-50 text-blue-700',
  FULFILLED: 'bg-emerald-50 text-emerald-700',
  CANCELLED: 'bg-gray-100 text-gray-500',
  FAILED: 'bg-red-50 text-red-600',
  EXPIRED: 'bg-gray-100 text-gray-500',
};

function StatusBadge({ status }: { status: string }) {
  const t = useTranslations();
  const cls = STATUS_COLORS[status] ?? 'bg-gray-100 text-gray-600';
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${cls}`}>
      {t(`admin.status.${status}`)}
    </span>
  );
}

const PAYMENT_STATUS_COLORS: Record<string, string> = {
  UNPAID: 'bg-amber-50 text-amber-700',
  PAID: 'bg-emerald-50 text-emerald-700',
  REFUNDED: 'bg-gray-100 text-gray-500',
  VOIDED: 'bg-gray-100 text-gray-500',
};

function PaymentBadge({ method, status }: { method: string; status: string }) {
  const t = useTranslations();
  const cls = PAYMENT_STATUS_COLORS[status] ?? 'bg-gray-100 text-gray-600';
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${cls}`}>
      {t(`admin.payment_method.${method}`)} · {t(`admin.payment_status.${status}`)}
    </span>
  );
}
