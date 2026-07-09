'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { adminLogin } from '@/lib/api';

interface Props {
  venueSlug: string;
}

export function LoginForm({ venueSlug }: Props) {
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
      router.push(`/admin/${venueSlug}`);
      router.refresh();
    } catch (err) {
      const e2 = err as Error & { status?: number };
      setError(e2.status === 401 ? t('admin.login.invalid') : t('admin.login.error'));
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
        <h1 className="text-xl font-bold text-gray-900 mb-1">{t('admin.login.title')}</h1>
        <p className="text-sm text-gray-500 mb-6">{venueSlug}</p>

        <label className="block text-sm font-medium text-gray-700 mb-1.5">{t('admin.login.email')}</label>
        <input
          type="email"
          required
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-gray-900"
        />

        <label className="block text-sm font-medium text-gray-700 mb-1.5">{t('admin.login.password')}</label>
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
          {submitting ? t('admin.login.submitting') : t('admin.login.submit')}
        </button>
      </form>
    </div>
  );
}
