'use client';
import { type ReactNode, useEffect } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { LocaleProvider, useLocale } from '@/context/LocaleContext';
import { CartProvider } from '@/context/CartContext';
import arMessages from '@/messages/ar.json';
import enMessages from '@/messages/en.json';

const messages = { ar: arMessages, en: enMessages } as const;

function IntlShell({ children }: { children: ReactNode }) {
  const { locale } = useLocale();

  // Sync html[lang] and html[dir] with active locale.
  // dir="rtl" is what Tailwind's rtl: utilities key off.
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
  }, [locale]);

  return (
    <NextIntlClientProvider locale={locale} messages={messages[locale]} timeZone="Africa/Cairo">
      {children}
    </NextIntlClientProvider>
  );
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <LocaleProvider>
      <CartProvider>
        <IntlShell>{children}</IntlShell>
      </CartProvider>
    </LocaleProvider>
  );
}
