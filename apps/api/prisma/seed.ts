import { PrismaClient, PosType, AgentStatus } from '@prisma/client';

const prisma = new PrismaClient();

// ── Demo venue menu — 4 categories, 9 items, 2 unavailable, 1 low-stock ──────
// Prices are integer piastres (EGP × 100), tax-inclusive.
// KOSHARY-SPECIAL has stock_count:2 so a live demo order visibly flips it sold out.
// TAAMIYYA and MANGO-JUICE are seeded unavailable to show the greyed-out state.
const ITEMS = [
  // Rice & Koshary
  {
    sku: 'KOSHARY-LG',
    name: 'Koshary Large',
    name_ar: 'كشري كبير',
    description: 'Generous bowl of rice, lentils, pasta, crispy onions, tomato and vinegar sauce',
    description_ar: 'حصة كبيرة من الكشري مع أرز وعدس ومكرونة وبصل مقرمش وصلصة الطماطم والخل',
    price: 6500,
    category: 'Rice & Koshary',
    category_ar: 'أرز وكشري',
    stock_count: null as number | null,
    available: true,
  },
  {
    sku: 'KOSHARY-SM',
    name: 'Koshary Small',
    name_ar: 'كشري صغير',
    description: 'Classic koshary with all the toppings',
    description_ar: 'كشري كلاسيكي بجميع التبيلات',
    price: 4500,
    category: 'Rice & Koshary',
    category_ar: 'أرز وكشري',
    stock_count: null as number | null,
    available: true,
  },
  {
    sku: 'KOSHARY-SPECIAL',
    name: 'Koshary Special',
    name_ar: 'كشري سبيشيال',
    description: 'XL bowl with double toppings and our signature spicy sauce — bestseller',
    description_ar: 'حصة XL مع تبيلة مضاعفة وصلصة حارة مميزة — الأكثر مبيعاً',
    price: 8500,
    category: 'Rice & Koshary',
    category_ar: 'أرز وكشري',
    stock_count: 2 as number | null, // deliberately low — demo: order 2 to flip it sold out
    available: true,
  },
  // Sandwiches
  {
    sku: 'FALAFEL',
    name: 'Falafel Sandwich',
    name_ar: 'ساندويتش فلافل',
    description: 'Crispy falafel, tahini sauce, fresh tomato and parsley in pita bread',
    description_ar: 'فلافل مقرمش مع طحينة وطماطم طازجة وبقدونس في خبز بلدي',
    price: 2500,
    category: 'Sandwiches',
    category_ar: 'ساندويتشات',
    stock_count: null as number | null,
    available: true,
  },
  {
    sku: 'TAAMIYYA',
    name: "Ta'amiyya Sandwich",
    name_ar: 'ساندويتش طعمية',
    description: 'Egyptian-style fava bean falafel — not available today',
    description_ar: 'طعمية مصرية بالفول الأخضر — غير متاحة اليوم',
    price: 2500,
    category: 'Sandwiches',
    category_ar: 'ساندويتشات',
    stock_count: null as number | null,
    available: false, // shows greyed-out unavailable state
  },
  // Sides
  {
    sku: 'EXTRA-SAUCE',
    name: 'Extra Sauce & Onions',
    name_ar: 'صلصة وبصل إضافي',
    description: 'Tomato sauce, vinegar sauce and extra crispy fried onions',
    description_ar: 'صلصة طماطم وخل وبصل مقلي مقرمش إضافي',
    price: 1000,
    category: 'Sides',
    category_ar: 'إضافات',
    stock_count: null as number | null,
    available: true,
  },
  // Drinks
  {
    sku: 'SOFT-DRINK',
    name: 'Soft Drink (330ml)',
    name_ar: 'مشروب غازي (330 مل)',
    description: 'Pepsi, 7Up or Mirinda',
    description_ar: 'بيبسي أو سفن أب أو ميرندا',
    price: 1800,
    category: 'Drinks',
    category_ar: 'مشروبات',
    stock_count: null as number | null,
    available: true,
  },
  {
    sku: 'MANGO-JUICE',
    name: 'Mango Juice (250ml)',
    name_ar: 'عصير مانجو (250 مل)',
    description: 'Juhayna mango juice — not available today',
    description_ar: 'عصير مانجو جهينة — غير متاح اليوم',
    price: 2200,
    category: 'Drinks',
    category_ar: 'مشروبات',
    stock_count: null as number | null,
    available: false, // shows second greyed-out state
  },
  {
    sku: 'WATER',
    name: 'Water (500ml)',
    name_ar: 'مياه (500 مل)',
    description: 'Still mineral water',
    description_ar: 'مياه معدنية غير غازية',
    price: 1000,
    category: 'Drinks',
    category_ar: 'مشروبات',
    stock_count: null as number | null,
    available: true,
  },
] as const;

// SKUs that belong to the demo menu. Anything else is deleted.
const KEEP_SKUS = ITEMS.map((i) => i.sku);

async function main() {
  // ── Venue ──────────────────────────────────────────────────────────────────
  // update: {} would keep the old name/color if already seeded — explicitly update both.
  const venue = await prisma.venue.upsert({
    where: { slug: 'demo' },
    update: {
      name: 'كشري الأصلي',
      primary_color: '#C0392B',
    },
    create: {
      slug: 'demo',
      name: 'كشري الأصلي',
      primary_color: '#C0392B',
      default_locale: 'ar',
      pos_type: PosType.PRINT_FALLBACK,
      stock_buffer: 0,
      active: true,
    },
  });

  console.log(`Venue: ${venue.name} (${venue.id})`);

  // ── Tables ─────────────────────────────────────────────────────────────────
  // nfc_slug is globally unique and short — encoded on the NFC tag/QR.
  // label is what prints on the kitchen ticket.
  const tables = [
    { nfc_slug: 't1', label: 'Table 1' },
    { nfc_slug: 't2', label: 'Table 2' },
    { nfc_slug: 't3', label: 'Table 3' },
    { nfc_slug: 't4', label: 'Table 4' },
  ];

  for (const t of tables) {
    await prisma.table.upsert({
      where: { nfc_slug: t.nfc_slug },
      update: {},
      create: { venue_id: venue.id, nfc_slug: t.nfc_slug, label: t.label },
    });
  }

  console.log(`Tables: ${tables.map((t) => t.nfc_slug).join(', ')}`);

  // ── Menu items ─────────────────────────────────────────────────────────────
  // First remove any stale items (e.g. old FALAFEL-SWC SKU from a previous seed).
  const { count: deleted } = await prisma.menuItem.deleteMany({
    where: { venue_id: venue.id, sku: { notIn: KEEP_SKUS as unknown as string[] } },
  });
  if (deleted > 0) console.log(`Removed ${deleted} stale menu item(s).`);

  for (const item of ITEMS) {
    const existing = await prisma.menuItem.findFirst({
      where: { venue_id: venue.id, sku: item.sku },
      select: { id: true },
    });

    await prisma.menuItem.upsert({
      where: { id: existing?.id ?? '00000000-0000-0000-0000-000000000000' },
      update: {
        name: item.name,
        name_ar: item.name_ar,
        description: item.description,
        description_ar: item.description_ar,
        price: item.price,
        category: item.category,
        category_ar: item.category_ar,
        stock_count: item.stock_count,
        reserved_count: 0,
        available: item.available,
      },
      create: {
        venue_id: venue.id,
        sku: item.sku,
        name: item.name,
        name_ar: item.name_ar,
        description: item.description,
        description_ar: item.description_ar,
        price: item.price,
        category: item.category,
        category_ar: item.category_ar,
        stock_count: item.stock_count,
        reserved_count: 0,
        available: item.available,
      },
    });
  }

  console.log(`Menu items: ${KEEP_SKUS.join(', ')}`);

  // ── Agent ──────────────────────────────────────────────────────────────────
  // The agent's UUID doubles as its API key (stored in agent .env as AGENT_API_KEY).
  // Use a stable test UUID so the value is predictable across seed runs.
  const DEMO_AGENT_KEY = '11111111-1111-1111-1111-111111111111';

  const existingAgent = await prisma.agent.findUnique({ where: { venue_id: venue.id } });
  if (!existingAgent) {
    await prisma.agent.create({
      data: {
        id: DEMO_AGENT_KEY,
        venue_id: venue.id,
        status: AgentStatus.OFFLINE,
      },
    });
    console.log(`Agent created. AGENT_API_KEY=${DEMO_AGENT_KEY}`);
  } else {
    console.log(`Agent exists.  AGENT_API_KEY=${existingAgent.id}`);
  }

  console.log('Seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
