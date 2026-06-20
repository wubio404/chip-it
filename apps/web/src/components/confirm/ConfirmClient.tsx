'use client';
import { useState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { getOrderStatus, cancelOrder } from '@/lib/api';

interface Props {
  orderId: string;
}

// After any of these statuses the order lifecycle is finished
const TERMINAL = new Set([
  'CONFIRMED', 'INJECTED', 'PRINTED', 'FULFILLED',
  'CANCELLED', 'EXPIRED', 'FAILED',
]);

const POLL_MS = 3000;
const CONN_FAIL_THRESHOLD = 5;

export function ConfirmClient({ orderId }: Props) {
  const t = useTranslations();

  const [status, setStatus] = useState<string | null>(null);
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
        // Order already confirmed — hide the button by updating status
        setStatus('CONFIRMED');
      } else {
        setCancelError(e.message ?? 'cancel_failed');
        setIsCancelling(false);
      }
    }
  }

  // Derived display state
  const isLoading = status === null;
  const isPending = status === 'CREATED' || status === 'PAYMENT_PENDING' || status === 'ROUTING';
  const isConfirmed = status != null && ['CONFIRMED', 'INJECTED', 'PRINTED', 'FULFILLED'].includes(status);
  const isCancelled = status === 'CANCELLED' || status === 'EXPIRED';
  const isFailed = status === 'FAILED';
  const showCancelBtn = status === 'CREATED'; // only while CREATED, hide once CONFIRMED

  const icon = isLoading || isPending
    ? '⏳'
    : isConfirmed
    ? '✅'
    : isCancelled
    ? '❌'
    : isFailed
    ? '⚠️'
    : '⏳';

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
      {/* Connection-error banner — only after 5 consecutive poll failures */}
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
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-gray-100 p-6 text-center">
          {/* Status icon */}
          <div className="text-5xl mb-4 select-none">{icon}</div>

          {/* Status heading */}
          <h1 className="text-xl font-bold text-gray-900 mb-1">{statusText}</h1>

          {/* Short order number */}
          <p className="text-sm text-gray-500 mb-6">
            {t('confirm.order_num')} <span className="font-mono font-bold">#{shortId}</span>
          </p>

          {/* Spinner while pending */}
          {(isLoading || isPending) && !isFailed && (
            <div className="flex justify-center mb-6">
              <div className="w-7 h-7 border-2 border-[var(--venue-primary)] border-t-transparent rounded-full animate-spin" />
            </div>
          )}

          {/* Cancel — visible only while CREATED */}
          {showCancelBtn && (
            <div className="mt-2">
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
      </main>
    </div>
  );
}
