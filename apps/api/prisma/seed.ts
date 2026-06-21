import { PrismaClient, PosType, AgentStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const venue = await prisma.venue.upsert({
    where: { slug: 'demo' },
    update: { name: 'TapOrder Demo', primary_color: '#E63946', stock_buffer: 0, active: true },
    create: {
      slug: 'demo',
      name: 'TapOrder Demo',
      primary_color: '#E63946',
      default_locale: 'ar',
      pos_type: PosType.PRINT_FALLBACK,
      stock_buffer: 0,
      active: true,
    },
  });

  console.log(`Venue: ${venue.name} (${venue.id})`);

  // Tables
  const tables = [
    { nfc_slug: 't1', label: 'Table 1' },
    { nfc_slug: 't2', label: 'Table 2' },
    { nfc_slug: 't3', label: 'Table 3' },
  ];

  for (const t of tables) {
    await prisma.table.upsert({
      where: { nfc_slug: t.nfc_slug },
      update: {},
      create: { venue_id: venue.id, nfc_slug: t.nfc_slug, label: t.label },
    });
  }

  console.log(`Tables: ${tables.map((t) => t.nfc_slug).join(', ')}`);

  // Menu items — delete and recreate so re-seeding always gives a clean state
  // (available reset, reserved_count reset, stock back to seed value).
  // Safe: Order.items is a JSON snapshot with no FK to MenuItem.
  await prisma.menuItem.deleteMany({ where: { venue_id: venue.id } });

  const items = [
    {
      sku: 'KOSHARY-LG',
      name: 'Koshary Large',
      name_ar: 'كشري كبير',
      description: 'Rice, lentils, pasta, crispy onions, tomato sauce',
      description_ar: 'أرز، عدس، مكرونة، بصل مقرمش، صلصة طماطم',
      price: 5000,
      category: 'Rice & Pasta',
      category_ar: 'أرز ومكرونة',
    },
    {
      sku: 'KOSHARY-SM',
      name: 'Koshary Small',
      name_ar: 'كشري صغير',
      description: 'Rice, lentils, pasta, crispy onions, tomato sauce',
      description_ar: 'أرز، عدس، مكرونة، بصل مقرمش، صلصة طماطم',
      price: 3500,
      category: 'Rice & Pasta',
      category_ar: 'أرز ومكرونة',
    },
    {
      sku: 'KOSHARY-SPECIAL',
      name: 'Koshary Special',
      name_ar: 'كشري سبيشيال',
      description: 'Large koshary with extra sauce and crispy onions',
      description_ar: 'كشري كبير مع صلصة إضافية وبصل مقرمش',
      price: 7500,
      category: 'Rice & Pasta',
      category_ar: 'أرز ومكرونة',
      stock_count: 2,   // finite stock — used for inventory tests
    },
    {
      sku: 'FALAFEL-SWC',
      name: 'Falafel Sandwich',
      name_ar: 'ساندويتش فلافل',
      description: 'Crispy falafel, tahini, fresh vegetables in pita bread',
      description_ar: 'فلافل مقرمش، طحينة، خضروات طازجة في خبز بيتا',
      price: 2500,
      category: 'Sandwiches',
      category_ar: 'ساندويتشات',
    },
    {
      sku: 'SOFT-DRINK',
      name: 'Soft Drink',
      name_ar: 'مشروب غازي',
      description: 'Pepsi, 7Up, or Mirinda (330ml)',
      description_ar: 'بيبسي أو سفن أب أو ميرندا (330 مل)',
      price: 1500,
      category: 'Drinks',
      category_ar: 'مشروبات',
    },
    {
      sku: 'WATER',
      name: 'Water',
      name_ar: 'مياه',
      description: 'Still water (500ml)',
      description_ar: 'مياه غير غازية (500 مل)',
      price: 1000,
      category: 'Drinks',
      category_ar: 'مشروبات',
    },
  ];

  await prisma.menuItem.createMany({
    data: items.map((item) => ({ venue_id: venue.id, ...item })),
  });

  console.log(`Menu items: ${items.map((i) => i.sku).join(', ')}`);

  // Agent — UUID doubles as the API key (stored in agent .env as AGENT_API_KEY).
  const DEMO_AGENT_KEY = '11111111-1111-1111-1111-111111111111';

  const existingAgent = await prisma.agent.findUnique({ where: { venue_id: venue.id } });
  if (!existingAgent) {
    await prisma.agent.create({
      data: { id: DEMO_AGENT_KEY, venue_id: venue.id, status: AgentStatus.OFFLINE },
    });
    console.log(`Agent created. AGENT_API_KEY=${DEMO_AGENT_KEY}`);
  } else {
    console.log(`Agent exists.  AGENT_API_KEY=${existingAgent.id}`);
  }

  console.log('Seed complete.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
