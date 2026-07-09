'use client';
import { useTranslations } from 'next-intl';
import { adminLogout } from '@/lib/api';

interface Props {
  venueSlug: string;
}

export function LogoutButton({ venueSlug }: Props) {
  const t = useTranslations();

  async function handleLogout() {
    await adminLogout();
    window.location.href = `/admin/${venueSlug}/login`;
  }

  return (
    <button
      onClick={handleLogout}
      className="text-sm font-medium px-3 py-1.5 rounded-full border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors flex-shrink-0"
    >
      {t('admin.logout')}
    </button>
  );
}
