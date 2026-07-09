'use client';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useLocale } from '@/context/LocaleContext';
import { fetchVenueClient, toggleItemAvailability } from '@/lib/api';
import type { MenuItem } from '@/lib/api';
import { formatEGP } from '@/lib/money';

interface Props {
  venueId: string;
  venueSlug: string;
}

export function MenuManager({ venueId, venueSlug }: Props) {
  const t = useTranslations();
  const { locale } = useLocale();
  const [items, setItems] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busySku, setBusySku] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetchVenueClient(venueSlug)
      .then((venue) => {
        if (active) setItems(venue.menu_items);
      })
      .catch(() => {
        if (active) setError(t('admin.menu.load_failed'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venueSlug]);

  async function handleToggle(item: MenuItem) {
    setBusySku(item.sku);
    setError(null);
    try {
      // Explicit target value (not a flip) — per the endpoint contract.
      const updated = await toggleItemAvailability(venueId, item.sku, !item.available);
      setItems((prev) => prev.map((i) => (i.sku === item.sku ? { ...i, available: updated.available } : i)));
    } catch {
      setError(t('admin.menu.toggle_failed'));
    } finally {
      setBusySku(null);
    }
  }

  if (loading) {
    return <p className="text-center text-gray-400 py-12 text-sm">…</p>;
  }

  const categories = new Map<string, MenuItem[]>();
  for (const item of items) {
    const key = locale === 'ar' ? (item.category_ar ?? item.category) : item.category;
    if (!categories.has(key)) categories.set(key, []);
    categories.get(key)!.push(item);
  }

  return (
    <div>
      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-100 px-3 py-2 rounded-lg mb-4">{error}</p>
      )}
      {Array.from(categories.entries()).map(([category, categoryItems]) => (
        <section key={category} className="mb-6">
          <h2 className="text-sm font-bold text-gray-700 mb-2 uppercase tracking-wide">{category}</h2>
          <div className="space-y-2">
            {categoryItems.map((item) => {
              const name = locale === 'ar' ? (item.name_ar ?? item.name) : item.name;
              return (
                <div
                  key={item.sku}
                  className="bg-white rounded-xl border border-gray-100 p-3 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{name}</p>
                    <p className="text-xs text-gray-500 tabular-nums">
                      {formatEGP(item.price)}
                      {item.stock_count != null && (
                        <span className="ms-2 text-gray-400">
                          {t('admin.menu.stock')}: {item.stock_count}
                        </span>
                      )}
                    </p>
                  </div>
                  <button
                    onClick={() => handleToggle(item)}
                    disabled={busySku === item.sku}
                    className={`flex-shrink-0 text-xs font-semibold px-3 py-1.5 rounded-full whitespace-nowrap disabled:opacity-50 ${
                      item.available
                        ? 'bg-red-50 text-red-600 hover:bg-red-100'
                        : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                    }`}
                  >
                    {item.available ? t('admin.menu.sold_out') : t('admin.menu.mark_available')}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
