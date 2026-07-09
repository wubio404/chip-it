import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { fetchAdminMeServer } from '@/lib/api';
import { AdminPanel } from '@/components/admin/AdminPanel';

interface Props {
  params: Promise<{ venue: string }>;
}

export default async function AdminVenuePage({ params }: Props) {
  const { venue: venueSlug } = await params;

  // Server components don't share the browser's cookie jar — forward the
  // incoming request's cookies manually so /admin/me sees the same session.
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.getAll().map((c) => `${c.name}=${c.value}`).join('; ');

  const result = await fetchAdminMeServer(venueSlug, cookieHeader);
  if (!result.ok) {
    // Already authenticated, just at another venue's URL — send them to their
    // own panel rather than a login page for a venue they can't access. Carry
    // the denied slug through so the panel can show WHY it bounced them back —
    // without this, landing back on your own venue's URL looks like nothing
    // happened at all (indistinguishable from just re-visiting your own page).
    if (result.status === 403 && result.ownVenueSlug) {
      redirect(`/admin/${result.ownVenueSlug}?denied=${encodeURIComponent(venueSlug)}`);
    }
    redirect(`/admin/${venueSlug}/login`);
  }

  const { me } = result;

  return (
    <AdminPanel
      venueId={me.venue.id}
      venueSlug={me.venue.slug}
      venueName={me.venue.name}
      defaultLocale={me.venue.default_locale}
    />
  );
}
