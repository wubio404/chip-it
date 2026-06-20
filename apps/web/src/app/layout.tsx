import type { Metadata } from 'next';
import './globals.css';
import { AppProviders } from '@/components/providers/AppProviders';

export const metadata: Metadata = {
  title: 'TapOrder',
  description: 'NFC-based self-ordering',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Default lang/dir are AR/RTL; AppProviders.IntlShell updates them via useEffect
  // as soon as the locale state is known (from venue.default_locale).
  return (
    <html lang="ar" dir="rtl">
      <body className="bg-gray-50 text-gray-900 antialiased">
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
