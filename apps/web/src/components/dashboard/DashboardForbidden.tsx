'use client';
import { useTranslations } from 'next-intl';
import { DashboardLogoutButton } from './DashboardLogoutButton';

// Shown when an authenticated but non-PLATFORM_ADMIN account (i.e. VENUE_STAFF)
// hits /dashboard. No venue/platform data is fetched or rendered on this path.
export function DashboardForbidden() {
  const t = useTranslations();

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-gray-100 p-6 text-center">
        <h1 className="text-xl font-bold text-gray-900 mb-2">{t('dashboard.forbidden.title')}</h1>
        <p className="text-sm text-gray-500 mb-6">{t('dashboard.forbidden.message')}</p>
        <DashboardLogoutButton />
      </div>
    </div>
  );
}
