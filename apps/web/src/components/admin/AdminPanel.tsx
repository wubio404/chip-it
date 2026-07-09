'use client';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useLocale } from '@/context/LocaleContext';
import { useOrderStream } from './useOrderStream';
import { OrderCard } from './OrderCard';
import { MenuManager } from './MenuManager';
import { LogoutButton } from './LogoutButton';

interface Props {
  venueId: string;
  venueSlug: string;
  venueName: string;
  defaultLocale: string;
}

type Tab = 'orders' | 'menu';

export function AdminPanel({ venueId, venueSlug, venueName, defaultLocale }: Props) {
  const t = useTranslations();
  const { locale, setLocale } = useLocale();
  const [tab, setTab] = useState<Tab>('orders');
  const [toast, setToast] = useState<string | null>(null);
  const { orders, connected, sseGaveUp, retry } = useOrderStream(venueId, venueSlug);

  // Initialise locale from the venue's default (mirrors the PWA's MenuPage pattern).
  useEffect(() => {
    setLocale(defaultLocale === 'en' ? 'en' : 'ar');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
  }, [locale]);

  const showToast = useCallback((message: string, durationMs = 3000) => {
    setToast(message);
    setTimeout(() => setToast(null), durationMs);
  }, []);

  // Landing here via the cross-venue-denied redirect (page.tsx) looks like
  // nothing happened — same venue, same layout — unless we explain it.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const denied = params.get('denied');
    if (denied) {
      showToast(t('admin.access_denied', { venue: denied }), 6000);
      params.delete('denied');
      const qs = params.toString();
      window.history.replaceState({}, '', qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-30 bg-white border-b border-gray-100 shadow-sm">
        <div className="flex items-center justify-between px-4 py-3 max-w-3xl mx-auto">
          <div className="min-w-0">
            <p className="font-bold text-gray-900 text-base leading-tight truncate">{venueName}</p>
            <p className="text-xs text-gray-400 flex items-center gap-1.5">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  connected ? 'bg-emerald-500' : sseGaveUp ? 'bg-amber-500' : 'bg-gray-300'
                }`}
              />
              {connected ? t('admin.feed.live') : sseGaveUp ? t('admin.feed.disconnected') : t('admin.feed.connecting')}
              {sseGaveUp && (
                <button onClick={retry} className="ms-1 underline font-medium text-amber-700 hover:text-amber-800">
                  {t('admin.feed.retry')}
                </button>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')}
              className="text-sm font-medium px-3 py-1.5 rounded-full border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
            >
              {locale === 'ar' ? 'English' : 'العربية'}
            </button>
            <LogoutButton venueSlug={venueSlug} />
          </div>
        </div>
        <div className="max-w-3xl mx-auto px-4 flex gap-4">
          <TabButton active={tab === 'orders'} onClick={() => setTab('orders')}>
            {t('admin.tabs.orders')}
          </TabButton>
          <TabButton active={tab === 'menu'} onClick={() => setTab('menu')}>
            {t('admin.tabs.menu')}
          </TabButton>
        </div>
      </header>

      {toast && (
        <div className="fixed top-4 inset-x-0 z-50 flex justify-center pointer-events-none px-4">
          <div className="bg-gray-900 text-white text-sm px-4 py-2.5 rounded-2xl shadow-lg pointer-events-auto max-w-sm text-center">
            {toast}
          </div>
        </div>
      )}

      <main className="max-w-3xl mx-auto px-4 py-4">
        {tab === 'orders' ? (
          orders.length === 0 ? (
            <p className="text-center text-gray-400 py-12 text-sm">{t('admin.orders.empty')}</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {orders.map((order) => (
                <OrderCard key={order.id} order={order} venueId={venueId} onToast={showToast} />
              ))}
            </div>
          )
        ) : (
          <MenuManager venueId={venueId} venueSlug={venueSlug} />
        )}
      </main>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`text-sm font-semibold py-2.5 border-b-2 transition-colors ${
        active ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-400 hover:text-gray-600'
      }`}
    >
      {children}
    </button>
  );
}
