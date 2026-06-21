'use client';
import { useState, useEffect, useMemo, useCallback } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useLocale } from '@/context/LocaleContext';
import { useCart } from '@/context/CartContext';
import { formatEGP } from '@/lib/money';
import { createOrder } from '@/lib/api';
import type { VenueResponse, MenuItem } from '@/lib/api';

/** Returns 1–2 initials from a venue name (works for Arabic and Latin). */
function getInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0][0] ?? '?';
  return (words[0][0] ?? '') + (words[1][0] ?? '');
}

interface Props {
  venue: VenueResponse;
  tableNfcSlug: string;
  tableLabel: string;
}

type SheetStep = 'cart' | 'checkout';
type PaymentMethod = 'CASH' | 'CARD' | 'APPLE_PAY';

export function MenuPage({ venue, tableNfcSlug, tableLabel }: Props) {
  const t = useTranslations();
  const { locale, setLocale } = useLocale();
  const cart = useCart();
  const router = useRouter();

  const [showSheet, setShowSheet] = useState(false);
  const [sheetStep, setSheetStep] = useState<SheetStep>('cart');
  const [customerName, setCustomerName] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('CASH');
  const [hasApplePay, setHasApplePay] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Set CSS variable for venue branding (never per-element inline styles)
  useEffect(() => {
    document.documentElement.style.setProperty('--venue-primary', venue.primary_color);
  }, [venue.primary_color]);

  // Initialise locale from venue.default_locale (runs once on mount)
  useEffect(() => {
    setLocale(venue.default_locale === 'en' ? 'en' : 'ar');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally empty — venue is SSR-static, setLocale is stable

  // Sync html[dir] / html[lang] whenever locale changes (also done in IntlShell,
  // but doing it here ensures it's set before first paint on this page)
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
  }, [locale]);

  // Detect Apple Pay (only available on Safari/Apple; cannot be tested locally)
  useEffect(() => {
    try {
      if (typeof window !== 'undefined' && 'ApplePaySession' in window) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setHasApplePay((window as any).ApplePaySession.canMakePayments() === true);
      }
    } catch {
      /* not available */
    }
  }, []);

  // Group menu items by English category key (stable), display name by locale
  const categories = useMemo(() => {
    const map = new Map<string, { displayName: string; items: MenuItem[] }>();
    for (const item of venue.menu_items) {
      if (!map.has(item.category)) {
        map.set(item.category, { displayName: '', items: [] });
      }
      const entry = map.get(item.category)!;
      entry.displayName =
        locale === 'ar' ? (item.category_ar ?? item.category) : item.category;
      entry.items.push(item);
    }
    return Array.from(map.values());
  }, [venue.menu_items, locale]);

  const getQty = useCallback(
    (sku: string) => cart.items.find(i => i.sku === sku)?.qty ?? 0,
    [cart.items],
  );

  function openSheet() {
    setSheetStep('cart');
    setShowSheet(true);
    setSubmitError(null);
  }

  function closeSheet() {
    setShowSheet(false);
    setSheetStep('cart');
    setSubmitError(null);
  }

  async function handleConfirm() {
    if (cart.items.length === 0 || isSubmitting) return;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const res = await createOrder({
        venue_slug: venue.slug,
        table_nfc_slug: tableNfcSlug,
        customer_name: customerName.trim() || undefined,
        payment_method: paymentMethod,
        items: cart.items.map(i => ({ sku: i.sku, qty: i.qty })),
      });

      cart.clear();

      if (paymentMethod === 'CASH') {
        const orderId = res.id ?? res.order_id;
        router.push(`/order/confirm/${orderId}`);
      } else {
        // CARD or APPLE_PAY — full-page redirect, no iframe
        if (!res.checkout_url) throw new Error('no_checkout_url');
        window.location.href = res.checkout_url;
      }
    } catch (err) {
      const e = err as Error & { data?: { error?: string } };
      setSubmitError(e.data?.error ?? e.message ?? 'order_failed');
      setIsSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* ── Header ── */}
      <header className="sticky top-0 z-30 bg-white shadow-sm">
        {/* Venue-primary accent bar */}
        <div className="h-1 bg-[var(--venue-primary)]" />
        <div className="flex items-center justify-between px-4 py-3 max-w-2xl mx-auto border-b border-gray-100">
          <div className="flex items-center gap-3 rtl:flex-row-reverse min-w-0">
            {/* Logo or initials avatar */}
            {venue.logo_url ? (
              <Image
                src={venue.logo_url}
                alt={venue.name}
                width={36}
                height={36}
                className="rounded-full object-cover flex-shrink-0"
              />
            ) : (
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-bold flex-shrink-0 select-none"
                style={{ backgroundColor: 'var(--venue-primary)' }}
                aria-hidden
              >
                {getInitials(venue.name)}
              </div>
            )}
            <div className="flex flex-col min-w-0">
              <span className="font-bold text-gray-900 text-base leading-tight truncate">{venue.name}</span>
              <span className="text-xs text-gray-400 leading-tight">{tableLabel}</span>
            </div>
          </div>
          <button
            onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')}
            className="text-sm font-medium px-3 py-1.5 rounded-full border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors flex-shrink-0 ms-3"
          >
            {locale === 'ar' ? 'English' : 'العربية'}
          </button>
        </div>
      </header>

      {/* ── Menu ── */}
      <main className="max-w-2xl mx-auto px-4 pb-32 pt-4">
        {categories.map(({ displayName, items }) => (
          <section key={displayName} className="mb-8">
            <h2 className="text-xs font-bold text-[var(--venue-primary)] mb-3 pb-2 border-b border-gray-100 uppercase tracking-widest">
              {displayName}
            </h2>
            <div className="space-y-3">
              {items.map(item => {
                const qty = getQty(item.sku);
                const name = locale === 'ar' ? (item.name_ar ?? item.name) : item.name;
                const desc = locale === 'ar'
                  ? (item.description_ar ?? item.description)
                  : item.description;

                return (
                  <div
                    key={item.sku}
                    className={`bg-white rounded-xl border border-gray-100 p-3 flex gap-3 items-start shadow-[0_1px_3px_rgba(0,0,0,0.04)]${!item.available ? ' opacity-50' : ''}`}
                  >
                    {/* Thumbnail */}
                    {item.image_url ? (
                      <div className="flex-shrink-0 w-20 h-20 rounded-lg overflow-hidden bg-gray-100">
                        <Image
                          src={item.image_url}
                          alt={name}
                          width={80}
                          height={80}
                          className="w-full h-full object-cover"
                        />
                      </div>
                    ) : (
                      <div className="flex-shrink-0 w-20 h-20 rounded-lg bg-gray-100 flex items-center justify-center text-3xl select-none">
                        🍽️
                      </div>
                    )}

                    {/* Details */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-gray-900 text-sm leading-snug">{name}</p>
                          {desc && (
                            <p className="text-xs text-gray-500 mt-0.5 line-clamp-2 leading-snug">{desc}</p>
                          )}
                          <p className="text-sm font-bold mt-1.5 text-[var(--venue-primary)]">
                            {formatEGP(item.price)}
                          </p>
                        </div>

                        {/* Add / qty controls */}
                        <div className="flex-shrink-0 pt-0.5">
                          {!item.available ? (
                            <span className="text-xs font-medium text-gray-400 bg-gray-100 px-2 py-1 rounded-full whitespace-nowrap">
                              {t('menu.sold_out')}
                            </span>
                          ) : qty === 0 ? (
                            <button
                              onClick={() =>
                                cart.addItem({
                                  sku: item.sku,
                                  name: item.name,
                                  name_ar: item.name_ar,
                                  price: item.price,
                                })
                              }
                              className="w-9 h-9 rounded-full flex items-center justify-center text-white text-xl font-bold bg-[var(--venue-primary)] hover:opacity-90 transition-opacity"
                              aria-label={`Add ${name}`}
                            >
                              +
                            </button>
                          ) : (
                            <div className="flex items-center gap-1.5">
                              <button
                                onClick={() => cart.setQty(item.sku, qty - 1)}
                                className="w-8 h-8 rounded-full border border-gray-200 flex items-center justify-center text-gray-700 text-base font-bold hover:bg-gray-50"
                                aria-label="Decrease quantity"
                              >
                                −
                              </button>
                              <span className="w-5 text-center text-sm font-bold text-gray-900 tabular-nums">
                                {qty}
                              </span>
                              <button
                                onClick={() =>
                                  cart.addItem({
                                    sku: item.sku,
                                    name: item.name,
                                    name_ar: item.name_ar,
                                    price: item.price,
                                  })
                                }
                                className="w-8 h-8 rounded-full flex items-center justify-center text-white text-base font-bold bg-[var(--venue-primary)] hover:opacity-90 transition-opacity"
                                aria-label="Increase quantity"
                              >
                                +
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </main>

      {/* ── Floating cart bar ── */}
      {cart.itemCount > 0 && !showSheet && (
        <div className="fixed bottom-0 inset-x-0 p-4 z-20 pointer-events-none">
          <div className="max-w-2xl mx-auto pointer-events-auto">
            <button
              onClick={openSheet}
              className="w-full flex items-center justify-between bg-[var(--venue-primary)] text-white px-5 py-3.5 rounded-2xl shadow-lg font-bold text-sm"
            >
              <span className="bg-white/25 px-2 py-0.5 rounded-full text-xs font-bold tabular-nums">
                {cart.itemCount}
              </span>
              <span>{t('menu.your_cart')}</span>
              <span className="tabular-nums">{formatEGP(cart.total)}</span>
            </button>
          </div>
        </div>
      )}

      {/* ── Bottom sheet: Cart + Checkout ── */}
      {showSheet && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/40 z-40"
            onClick={closeSheet}
            aria-hidden
          />

          {/* Sheet panel */}
          <div className="fixed inset-x-0 bottom-0 z-50 bg-white rounded-t-2xl shadow-2xl flex flex-col max-h-[88vh]">
            {/* Drag handle */}
            <div className="flex justify-center pt-3 pb-1 flex-shrink-0">
              <div className="w-10 h-1 bg-gray-300 rounded-full" />
            </div>

            {/* Sheet header */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100 flex-shrink-0">
              {sheetStep === 'checkout' ? (
                <button
                  onClick={() => setSheetStep('cart')}
                  className="text-gray-500 text-sm font-medium px-1 py-1 hover:text-gray-700"
                >
                  {locale === 'ar' ? '←' : '←'}
                </button>
              ) : (
                <span className="w-8" />
              )}
              <h3 className="font-bold text-gray-900 text-base">
                {sheetStep === 'cart' ? t('menu.your_cart') : t('checkout.title')}
              </h3>
              <button
                onClick={closeSheet}
                className="text-gray-400 text-2xl leading-none w-8 text-center hover:text-gray-600"
                aria-label="Close"
              >
                ×
              </button>
            </div>

            {/* Scrollable content */}
            <div className="flex-1 overflow-y-auto px-4 py-4 min-h-0">
              {sheetStep === 'cart' && <CartView locale={locale} />}
              {sheetStep === 'checkout' && (
                <CheckoutForm
                  locale={locale}
                  customerName={customerName}
                  setCustomerName={setCustomerName}
                  paymentMethod={paymentMethod}
                  setPaymentMethod={setPaymentMethod}
                  hasApplePay={hasApplePay}
                  submitError={submitError}
                  t={t}
                />
              )}
            </div>

            {/* Footer: total + CTA */}
            <div className="flex-shrink-0 px-4 pb-8 pt-3 border-t border-gray-100">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm text-gray-600 font-medium">{t('checkout.total')}</span>
                <span className="text-lg font-bold text-gray-900 tabular-nums">
                  {formatEGP(cart.total)}
                </span>
              </div>
              {sheetStep === 'cart' ? (
                <button
                  onClick={() => { if (cart.items.length > 0) setSheetStep('checkout'); }}
                  disabled={cart.items.length === 0}
                  className="w-full py-3.5 rounded-2xl text-white font-bold text-sm bg-[var(--venue-primary)] disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
                >
                  {t('menu.checkout')}
                </button>
              ) : (
                <button
                  onClick={handleConfirm}
                  disabled={isSubmitting}
                  className="w-full py-3.5 rounded-2xl text-white font-bold text-sm bg-[var(--venue-primary)] disabled:opacity-60 hover:opacity-90 transition-opacity"
                >
                  {isSubmitting ? t('checkout.processing') : t('checkout.confirm')}
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function CartView({ locale }: { locale: string }) {
  const t = useTranslations();
  const cart = useCart();

  if (cart.items.length === 0) {
    return (
      <p className="text-center text-gray-400 py-12 text-sm">{t('menu.empty')}</p>
    );
  }

  return (
    <div className="space-y-3">
      {cart.items.map(item => {
        const name = locale === 'ar' ? (item.name_ar ?? item.name) : item.name;
        return (
          <div key={item.sku} className="flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 truncate">{name}</p>
              <p className="text-xs text-gray-500 tabular-nums">{formatEGP(item.price)}</p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={() => cart.setQty(item.sku, item.qty - 1)}
                className="w-7 h-7 rounded-full border border-gray-200 flex items-center justify-center text-gray-700 font-bold hover:bg-gray-50 text-base"
              >
                −
              </button>
              <span className="w-5 text-center text-sm font-bold tabular-nums">{item.qty}</span>
              <button
                onClick={() => cart.addItem({ sku: item.sku, name: item.name, name_ar: item.name_ar, price: item.price })}
                className="w-7 h-7 rounded-full flex items-center justify-center text-white font-bold bg-[var(--venue-primary)] hover:opacity-90 text-base"
              >
                +
              </button>
            </div>
            <p className="text-sm font-bold w-16 text-end tabular-nums flex-shrink-0">
              {formatEGP(item.price * item.qty)}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function CheckoutForm({
  locale,
  customerName,
  setCustomerName,
  paymentMethod,
  setPaymentMethod,
  hasApplePay,
  submitError,
  t,
}: {
  locale: string;
  customerName: string;
  setCustomerName: (v: string) => void;
  paymentMethod: 'CASH' | 'CARD' | 'APPLE_PAY';
  setPaymentMethod: (v: 'CASH' | 'CARD' | 'APPLE_PAY') => void;
  hasApplePay: boolean;
  submitError: string | null;
  t: ReturnType<typeof useTranslations>;
}) {
  const methods: Array<{ value: 'CASH' | 'CARD' | 'APPLE_PAY'; label: string; show: boolean }> = [
    { value: 'CASH', label: t('checkout.cash'), show: true },
    { value: 'CARD', label: t('checkout.card'), show: true },
    { value: 'APPLE_PAY', label: t('checkout.apple_pay'), show: hasApplePay },
  ];

  return (
    <div className="space-y-5">
      {/* Name input */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1.5">
          {t('checkout.name_label')}
        </label>
        <input
          type="text"
          value={customerName}
          onChange={e => setCustomerName(e.target.value)}
          placeholder={t('checkout.name_placeholder')}
          className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--venue-primary)] placeholder:text-gray-400 bg-white"
          dir={locale === 'ar' ? 'rtl' : 'ltr'}
        />
      </div>

      {/* Payment method */}
      <div>
        <p className="text-sm font-medium text-gray-700 mb-2">{t('checkout.payment_label')}</p>
        <div className="space-y-2">
          {methods.filter(m => m.show).map(method => {
            const selected = paymentMethod === method.value;
            return (
              <label
                key={method.value}
                className={`flex items-center gap-3 p-3 border rounded-xl cursor-pointer transition-colors ${
                  selected
                    ? 'border-[var(--venue-primary)] bg-[var(--venue-primary)]/5'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <input
                  type="radio"
                  name="payment_method"
                  value={method.value}
                  checked={selected}
                  onChange={() => setPaymentMethod(method.value)}
                  className="accent-[var(--venue-primary)] flex-shrink-0"
                />
                <span className="text-sm font-medium text-gray-800">{method.label}</span>
              </label>
            );
          })}
        </div>
      </div>

      {/* Error */}
      {submitError && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-100 px-3 py-2 rounded-lg">
          {submitError}
        </p>
      )}
    </div>
  );
}
