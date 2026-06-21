'use client';
import { useState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { getOrderStatus, cancelOrder } from '@/lib/api';
import { formatEGP } from '@/lib/money';

interface Props {
  orderId: string;
}

const TERMINAL = new Set([
  'CONFIRMED', 'INJECTED', 'PRINTED', 'FULFILLED',
  'CANCELLED', 'EXPIRED', 'FAILED',
]);

const POLL_MS = 3000;
const CONN_FAIL_THRESHOLD = 5;

// ── Styled status icons — no emoji, no external deps ──────────────────────────

function IconPending() {
  return (
    <div className="w-16 h-16 rounded-full border-4 border-gray-100 border-t-gray-400 animate-spin" />
  );
}

function IconConfirmed() {
  return (
    <div className="w-16 h-16 rounded-full bg-emerald-500 flex items-center justify-center">
      <svg className="w-8 h-8 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    </div>
  );
}

function IconCancelled() {
  return (
    <div className="w-16 h-16 rounded-full bg-gray-200 flex items-center justify-center">
      <svg className="w-8 h-8 text-gray-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </div>
  );
}

function IconFailed() {
  return (
    <div className="w-16 h-16 rounded-full bg-amber-100 flex items-center justify-center">
      <svg className="w-8 h-8 text-amber-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
        <path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      </svg>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export function ConfirmClient({ orderId }: Props) {
  const t = useTranslations();

  const [status, setStatus] = useState<string | null>(null);
  const [tableLabel, setTableLabel] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [failCount, setFailCount] = useState(0);
  const [showBanner, setShowBanner] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const activeRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const shortId = orderId.slice(-6).toUpperCase();

  useEffect(() => {
    activeRef.current = true;

    async function poll() {
      if (!activeRef.current) return;
      try {
        const data = await getOrderStatus(orderId);
        if (!activeRef.current) return;
        setStatus(data.status);
        // Capture table and total on first successful response — they don't change.
        if (data.table_label) setTableLabel(data.table_label);
        if (data.total) setTotal(data.total);
        setFailCount(0);
        setShowBanner(false);
        if (!TERMINAL.has(data.status)) {
          timerRef.current = setTimeout(poll, POLL_MS);
        }
      } catch {
        if (!activeRef.current) return;
        setFailCount(c => {
          const next = c + 1;
          if (next >= CONN_FAIL_THRESHOLD) setShowBanner(true);
          return next;
        });
        // Keep polling even on failure — do not stop
        timerRef.current = setTimeout(poll, POLL_MS);
      }
    }

    poll();

    return () => {
      activeRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [orderId]);

  async function handleCancel() {
    if (isCancelling) return;
    setIsCancelling(true);
    setCancelError(null);
    try {
      await cancelOrder(orderId);
      setStatus('CANCELLED');
    } catch (err) {
      const e = err as Error & { status?: number };
      if (e.status === 409) {
        setStatus('CONFIRMED');
      } else {
        setCancelError(e.message ?? 'cancel_failed');
        setIsCancelling(false);
      }
    }
  }

  const isLoading   = status === null;
  const isPending   = status === 'CREATED' || status === 'PAYMENT_PENDING' || status === 'ROUTING';
  const isConfirmed = status != null && ['CONFIRMED', 'INJECTED', 'PRINTED', 'FULFILLED'].includes(status);
  const isCancelled = status === 'CANCELLED' || status === 'EXPIRED';
  const isFailed    = status === 'FAILED';
  const showCancelBtn = status === 'CREATED';

  const statusText = isLoading
    ? t('confirm.pending')
    : status === 'PAYMENT_PENDING'
    ? t('confirm.payment_pending')
    : isConfirmed
    ? t('confirm.confirmed')
    : isCancelled
    ? t('confirm.cancelled')
    : isFailed
    ? t('confirm.failed')
    : t('confirm.pending');

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Connection-error banner */}
      {showBanner && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 flex items-center justify-between flex-shrink-0">
          <p className="text-sm text-amber-700">{t('confirm.conn_error')}</p>
          <button
            onClick={() => { setShowBanner(false); setFailCount(0); }}
            className="text-amber-500 text-xl leading-none ms-3 hover:text-amber-700"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      <main className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          {/* Coloured top strip — uses the CSS default (black) since venue color isn't
              available on this page; keeps the card looking intentional regardless */}
          <div className="h-1.5 bg-gray-900" />

          <div className="p-6 text-center">
            {/* Status icon */}
            <div className="flex justify-center mb-5">
              {(isLoading || isPending) ? <IconPending />
                : isConfirmed           ? <IconConfirmed />
                : isCancelled           ? <IconCancelled />
                :                         <IconFailed />}
            </div>

            {/* Status heading */}
            <h1 className="text-xl font-bold text-gray-900 mb-1">{statusText}</h1>

            {/* Short order number */}
            <p className="text-sm text-gray-400 mb-4">
              {t('confirm.order_num')} <span className="font-mono font-bold text-gray-600">#{shortId}</span>
            </p>

            {/* Table + total — shown once the first status poll returns */}
            {(tableLabel || total != null) && (
              <div className="flex justify-center gap-5 text-sm text-gray-500 mb-4">
                {tableLabel && (
                  <span>
                    <span className="text-gray-400">{t('confirm.table')} </span>
                    <span className="font-semibold text-gray-700">{tableLabel}</span>
                  </span>
                )}
                {total != null && (
                  <span>
                    <span className="text-gray-400">{t('confirm.total')} </span>
                    <span className="font-semibold text-gray-700">{formatEGP(total)}</span>
                  </span>
                )}
              </div>
            )}

            {/* Cancel — visible only while CREATED */}
            {showCancelBtn && (
              <div className="mt-2 pt-4 border-t border-gray-100">
                {cancelError && (
                  <p className="text-xs text-red-600 mb-2">{cancelError}</p>
                )}
                <button
                  onClick={handleCancel}
                  disabled={isCancelling}
                  className="text-sm font-medium text-red-500 underline hover:text-red-600 disabled:opacity-50"
                >
                  {isCancelling ? t('confirm.cancelling') : t('confirm.cancel_btn')}
                </button>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
