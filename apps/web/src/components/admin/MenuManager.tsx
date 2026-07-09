'use client';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useLocale } from '@/context/LocaleContext';
import { fetchVenueClient, toggleItemAvailability, presignItemImage, confirmItemImage } from '@/lib/api';
import type { MenuItem } from '@/lib/api';
import { formatEGP } from '@/lib/money';

interface Props {
  venueId: string;
  venueSlug: string;
}

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_EDGE = 1024;

// Scales the image so its longest edge is at most MAX_IMAGE_EDGE, preserving
// aspect ratio, and re-encodes to the same mime type. Browser Canvas API only —
// no added dependency.
async function resizeImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas_unsupported');
  ctx.drawImage(bitmap, 0, 0, width, height);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, file.type, 0.85));
  if (!blob) throw new Error('encode_failed');
  return blob;
}

export function MenuManager({ venueId, venueSlug }: Props) {
  const t = useTranslations();
  const { locale } = useLocale();
  const [items, setItems] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busySku, setBusySku] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadingSku, setUploadingSku] = useState<string | null>(null);
  const [imageErrors, setImageErrors] = useState<Record<string, string>>({});

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

  async function handleImageSelect(item: MenuItem, file: File) {
    setImageErrors((prev) => ({ ...prev, [item.sku]: '' }));

    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      setImageErrors((prev) => ({ ...prev, [item.sku]: t('admin.menu.image.invalid_type') }));
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setImageErrors((prev) => ({ ...prev, [item.sku]: t('admin.menu.image.too_large') }));
      return;
    }

    setUploadingSku(item.sku);
    try {
      const resized = await resizeImage(file);

      const presign = await presignItemImage(venueId, item.sku, resized.type, resized.size);

      // Direct upload to R2 — raw fetch, NOT the api.ts client, NO app cookies.
      // Content-Type must exactly match what was presigned or the signature fails.
      const putRes = await fetch(presign.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': resized.type },
        body: resized,
        credentials: 'omit',
      });
      if (!putRes.ok) throw new Error(`upload_failed:${putRes.status}`);

      const confirmed = await confirmItemImage(venueId, item.sku, presign.key);
      setItems((prev) => prev.map((i) => (i.sku === item.sku ? { ...i, image_url: confirmed.image_url } : i)));
    } catch {
      setImageErrors((prev) => ({ ...prev, [item.sku]: t('admin.menu.image.upload_failed') }));
    } finally {
      setUploadingSku(null);
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
              const isUploading = uploadingSku === item.sku;
              return (
                <div
                  key={item.sku}
                  className="bg-white rounded-xl border border-gray-100 p-3 flex items-center gap-3"
                >
                  {/* Thumbnail */}
                  <div className="flex-shrink-0 w-12 h-12 rounded-lg overflow-hidden bg-gray-100 flex items-center justify-center">
                    {item.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element -- admin thumbnail, not next/image (no LCP/remote-pattern concerns here)
                      <img src={item.image_url} alt={name} className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-xl select-none">🍽️</span>
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-gray-900 truncate">{name}</p>
                    <p className="text-xs text-gray-500 tabular-nums">
                      {formatEGP(item.price)}
                      {item.stock_count != null && (
                        <span className="ms-2 text-gray-400">
                          {t('admin.menu.stock')}: {item.stock_count}
                        </span>
                      )}
                    </p>
                    <label className="text-xs font-semibold text-blue-600 hover:text-blue-700 cursor-pointer inline-block mt-1">
                      {isUploading
                        ? t('admin.menu.image.uploading')
                        : item.image_url
                          ? t('admin.menu.image.replace')
                          : t('admin.menu.image.upload')}
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        className="hidden"
                        disabled={isUploading}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = '';
                          if (file) void handleImageSelect(item, file);
                        }}
                      />
                    </label>
                    {imageErrors[item.sku] && (
                      <p className="text-xs text-red-600 mt-0.5">{imageErrors[item.sku]}</p>
                    )}
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
