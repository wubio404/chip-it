'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { adminLogin } from '@/lib/api';

// Platform-admin login. Posts to the same /auth/login endpoint as the venue
// staff login (Session 1) — the account's role, not the route, decides what
// the resulting session can access; the dashboard checks role === 'PLATFORM_ADMIN'
// server-side on /dashboard itself (see app/dashboard/page.tsx).
export function DashboardLoginForm() {
  const t = useTranslations();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await adminLogin(email, password);
      router.push('/dashboard');
      router.refresh();
    } catch (err) {
      const e2 = err as Error & { status?: number };
      setError(e2.status === 401 ? t('dashboard.login.invalid') : t('dashboard.login.error'));
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
        <h1 className="text-xl font-bold text-gray-900 mb-6">{t('dashboard.login.title')}</h1>

        <label className="block text-sm font-medium text-gray-700 mb-1.5">{t('dashboard.login.email')}</label>
        <input
          type="email"
          required
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-gray-900"
        />

        <label className="block text-sm font-medium text-gray-700 mb-1.5">{t('dashboard.login.password')}</label>
        <input
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-gray-900"
        />

        {error && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-100 px-3 py-2 rounded-lg mb-4">{error}</p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full py-3 rounded-xl text-white font-bold text-sm bg-gray-900 disabled:opacity-60 hover:opacity-90 transition-opacity"
        >
          {submitting ? t('dashboard.login.submitting') : t('dashboard.login.submit')}
        </button>
      </form>
    </div>
  );
}
