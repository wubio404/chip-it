/**
 * Demo venue reset — restores stock counts, availability, and clears all orders.
 * Run before every live pitch: `npm run demo:reset` (from apps/api).
 *
 * This script does NOT recreate the venue, tables, or agent — run `npm run db:seed`
 * for initial setup. This is a fast state-reset only.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Canonical seeded state for each demo menu item.
// Must mirror seed.ts ITEMS exactly: stock_count, reserved_count, available.
const SEEDED_STATE: Array<{
  sku: string;
  stock_count: number | null;
  reserved_count: number;
  available: boolean;
}> = [
  { sku: 'KOSHARY-LG',      stock_count: null, reserved_count: 0, available: true  },
  { sku: 'KOSHARY-SM',      stock_count: null, reserved_count: 0, available: true  },
  { sku: 'KOSHARY-SPECIAL', stock_count: 2,    reserved_count: 0, available: true  },
  { sku: 'FALAFEL',         stock_count: null, reserved_count: 0, available: true  },
  { sku: 'TAAMIYYA',        stock_count: null, reserved_count: 0, available: false },
  { sku: 'EXTRA-SAUCE',     stock_count: null, reserved_count: 0, available: true  },
  { sku: 'SOFT-DRINK',      stock_count: null, reserved_count: 0, available: true  },
  { sku: 'MANGO-JUICE',     stock_count: null, reserved_count: 0, available: false },
  { sku: 'WATER',           stock_count: null, reserved_count: 0, available: true  },
];

async function main() {
  const venue = await prisma.venue.findUnique({ where: { slug: 'demo' } });
  if (!venue) {
    console.error('Demo venue not found — run `npm run db:seed` first to create it.');
    process.exit(1);
  }

  console.log(`Resetting demo venue: ${venue.name} (${venue.id})`);

  // 1. Delete all orders for this venue so the live feed looks clean.
  const { count: deletedOrders } = await prisma.order.deleteMany({
    where: { venue_id: venue.id },
  });
  console.log(`  Orders deleted:     ${deletedOrders}`);

  // 2. Restore every menu item to its seeded stock/availability state.
  let restored = 0;
  for (const { sku, stock_count, reserved_count, available } of SEEDED_STATE) {
    const { count } = await prisma.menuItem.updateMany({
      where: { venue_id: venue.id, sku },
      data: { stock_count, reserved_count, available },
    });
    restored += count;
  }
  console.log(`  Menu items reset:   ${restored}`);

  console.log('Demo reset complete — ready for a fresh pitch.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
