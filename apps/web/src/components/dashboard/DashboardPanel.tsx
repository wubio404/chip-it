'use client';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useLocale } from '@/context/LocaleContext';
import { fetchPlatformSummary, fetchPlatformVenues } from '@/lib/api';
import type { PlatformSummary, PlatformVenue, OrderStatusName } from '@/lib/api';
import { formatEGP } from '@/lib/money';
import { DashboardLogoutButton } from './DashboardLogoutButton';

const STATUS_ORDER: OrderStatusName[] = [
  'CREATED', 'PAYMENT_PENDING', 'CONFIRMED', 'ROUTING', 'INJECTED',
  'PRINTED', 'FULFILLED', 'CANCELLED', 'FAILED', 'EXPIRED',
];

export function DashboardPanel() {
  const t = useTranslations();
  const { locale, setLocale } = useLocale();
  const [summary, setSummary] = useState<PlatformSummary | null>(null);
  const [venues, setVenues] = useState<PlatformVenue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
  }, [locale]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    Promise.all([fetchPlatformSummary(), fetchPlatformVenues()])
      .then(([summaryRes, venuesRes]) => {
        if (!active) return;
        setSummary(summaryRes);
        setVenues(venuesRes.venues);
      })
      .catch(() => {
        if (active) setError(t('dashboard.load_failed'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-30 bg-white border-b border-gray-100 shadow-sm">
        <div className="flex items-center justify-between px-4 py-3 max-w-5xl mx-auto">
          <p className="font-bold text-gray-900 text-base">{t('dashboard.title')}</p>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')}
              className="text-sm font-medium px-3 py-1.5 rounded-full border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
            >
              {locale === 'ar' ? 'English' : 'العربية'}
            </button>
            <DashboardLogoutButton />
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-4">
        {loading ? (
          <p className="text-center text-gray-400 py-12 text-sm">…</p>
        ) : error ? (
          <p className="text-center text-red-600 bg-red-50 border border-red-100 px-3 py-2 rounded-lg text-sm">
            {error}
          </p>
        ) : (
          <>
            {summary && <SummaryStrip summary={summary} t={t} />}
            <VenuesTable venues={venues} t={t} />
          </>
        )}
      </main>
    </div>
  );
}

function SummaryStrip({ summary, t }: { summary: PlatformSummary; t: ReturnType<typeof useTranslations> }) {
  const tiles: Array<{ label: string; value: string }> = [
    { label: t('dashboard.summary.venues_total'), value: String(summary.venues_total) },
    { label: t('dashboard.summary.venues_active'), value: String(summary.venues_active) },
    { label: t('dashboard.summary.orders_today'), value: String(summary.orders_today) },
    { label: t('dashboard.summary.revenue_today'), value: formatEGP(summary.revenue_today) },
  ];

  return (
    <div className="mb-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        {tiles.map((tile) => (
          <div key={tile.label} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
            <p className="text-xs text-gray-400 mb-1">{tile.label}</p>
            <p className="text-xl font-bold text-gray-900">{tile.value}</p>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
        <p className="text-xs font-medium text-gray-500 mb-3">{t('dashboard.summary.by_status')}</p>
        <div className="flex flex-wrap gap-2">
          {STATUS_ORDER.map((status) => (
            <span
              key={status}
              className="text-xs font-medium px-2.5 py-1 rounded-full bg-gray-100 text-gray-700"
            >
              {t(`admin.status.${status}`)}: {summary.orders_today_by_status[status]}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function AgentBadge({ venue, t }: { venue: PlatformVenue; t: ReturnType<typeof useTranslations> }) {
  if (!venue.agent) {
    return (
      <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-gray-100 text-gray-500">
        {t('dashboard.agent.none')}
      </span>
    );
  }

  const color =
    venue.agent.status === 'ONLINE'
      ? 'bg-emerald-100 text-emerald-700'
      : venue.agent.status === 'DEGRADED'
        ? 'bg-amber-100 text-amber-700'
        : 'bg-red-100 text-red-700';

  return (
    <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${color}`}>
      {t(`dashboard.agent.${venue.agent.status}`)}
    </span>
  );
}

function VenuesTable({ venues, t }: { venues: PlatformVenue[]; t: ReturnType<typeof useTranslations> }) {
  if (venues.length === 0) {
    return <p className="text-center text-gray-400 py-12 text-sm">{t('dashboard.venues.empty')}</p>;
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100 text-start">
            <Th>{t('dashboard.venues.columns.name')}</Th>
            <Th>{t('dashboard.venues.columns.active')}</Th>
            <Th>{t('dashboard.venues.columns.pos_type')}</Th>
            <Th>{t('dashboard.venues.columns.orders_total')}</Th>
            <Th>{t('dashboard.venues.columns.orders_today')}</Th>
            <Th>{t('dashboard.venues.columns.revenue_today')}</Th>
            <Th>{t('dashboard.venues.columns.agent')}</Th>
          </tr>
        </thead>
        <tbody>
          {venues.map((v) => (
            <tr key={v.id} className="border-b border-gray-50 last:border-0">
              <Td>
                <p className="font-semibold text-gray-900">{v.name}</p>
                <p className="text-xs text-gray-400">{v.slug}</p>
              </Td>
              <Td>
                <span
                  className={`text-xs font-medium px-2.5 py-1 rounded-full ${
                    v.active ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'
                  }`}
                >
                  {v.active ? t('dashboard.venues.active_yes') : t('dashboard.venues.active_no')}
                </span>
              </Td>
              <Td>{v.pos_type}</Td>
              <Td>{v.orders_total}</Td>
              <Td>{v.orders_today}</Td>
              <Td>{formatEGP(v.revenue_today)}</Td>
              <Td>
                <AgentBadge venue={v} t={t} />
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-4 py-2.5 text-xs font-medium text-gray-500 whitespace-nowrap">{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-4 py-3 whitespace-nowrap">{children}</td>;
}
