import { fetchVenue } from '@/lib/api';
import { MenuPage } from '@/components/menu/MenuPage';

interface Props {
  searchParams: Promise<{ venue?: string; table?: string }>;
}

export default async function OrderPage({ searchParams }: Props) {
  const { venue: venueSlug, table: nfcSlug } = await searchParams;

  if (!venueSlug || !nfcSlug) {
    return (
      <ErrorScreen
        ar="رابط غير صحيح — امسح الكود مرة أخرى"
        en="Invalid link — please scan the code again"
      />
    );
  }

  let venue;
  try {
    venue = await fetchVenue(venueSlug);
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 404) {
      return <ErrorScreen ar="المطعم غير موجود" en="Venue not found" />;
    }
    return <ErrorScreen ar="حدث خطأ، حاول مرة أخرى" en="Something went wrong, please try again" />;
  }

  const table = venue.tables.find(t => t.nfc_slug === nfcSlug);
  if (!table) {
    return <ErrorScreen ar="الطاولة غير موجودة" en="Table not found" />;
  }

  return <MenuPage venue={venue} tableNfcSlug={nfcSlug} tableLabel={table.label} />;
}

function ErrorScreen({ ar, en }: { ar: string; en: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="text-center">
        <p className="text-2xl mb-3">😕</p>
        <p className="text-base font-semibold text-gray-800">{ar}</p>
        <p className="text-sm text-gray-500 mt-1">{en}</p>
      </div>
    </div>
  );
}
