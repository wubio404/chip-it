'use client';
import { useTranslations } from 'next-intl';
import { adminLogout } from '@/lib/api';

export function DashboardLogoutButton() {
  const t = useTranslations();

  async function handleLogout() {
    await adminLogout();
    window.location.href = '/dashboard/login';
  }

  return (
    <button
      onClick={handleLogout}
      className="text-sm font-medium px-3 py-1.5 rounded-full border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors flex-shrink-0"
    >
      {t('dashboard.logout')}
    </button>
  );
}
