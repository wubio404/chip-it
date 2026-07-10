import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { fetchPlatformMeServer } from '@/lib/api';
import { DashboardPanel } from '@/components/dashboard/DashboardPanel';
import { DashboardForbidden } from '@/components/dashboard/DashboardForbidden';

export default async function DashboardPage() {
  // Server components don't share the browser's cookie jar — forward the
  // incoming request's cookies manually so /admin/me sees the same session.
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.getAll().map((c) => `${c.name}=${c.value}`).join('; ');

  const result = await fetchPlatformMeServer(cookieHeader);
  if (!result.ok) {
    redirect('/dashboard/login');
  }

  // Authenticated, but not a platform admin (e.g. VENUE_STAFF) — show a 403
  // state without fetching or rendering any venue/platform data.
  if (result.me.user.role !== 'PLATFORM_ADMIN') {
    return <DashboardForbidden />;
  }

  return <DashboardPanel />;
}
