# TapOrder — Full Technical Specification
> NFC-Based Self-Ordering & Payment Platform for Egyptian F&B Market  
> Version 1.1 | For use with Claude Code

---

## Changelog — v1.1

This revision resolves internal inconsistencies in v1.0 and adds missing flows. Read this list before the spec; every item below is reflected in the relevant section.

- **Code is now explicitly normative vs. illustrative** (see new note at top of Section 5). Only the Prisma schema and the TypeScript interfaces are drop-in. Every other code block is a sketch.
- **Single canonical order state machine** (Section 5.2). v1.0 defined the lifecycle three different, conflicting ways. There is now one diagram, referenced everywhere.
- **Payment is now separate from fulfillment.** Added `payment_method` (CARD / APPLE_PAY / CASH) and `payment_status` (UNPAID / PAID / REFUNDED / VOIDED). This was required to support cash and refunds cleanly.
- **Cancellation & refund flow added** (new Section 5.9), with `CANCELLED` / `REFUNDED` states and Paymob Refund/Void wiring.
- **Three payment methods**: card + Apple Pay (one shared Paymob intention) and cash (offline, collected at the table). Section 5.8 rewritten.
- **Per-venue Paymob, not a single platform account** (Section 5.8). Money settles to each restaurant; the platform takes its cut via flat SaaS fee (default) or Paymob Split Payment (commission option). The platform never holds restaurant funds.
- **Stock now decrements on order confirmation, not creation** (Section 5.7). Fixes the v1.0 bug where abandoned carts permanently sold out items. Added reservation + expiry + restock-on-cancel.
- **Fallback chain moved into the router** (Section 5.4). Connectors are now pure and return `ConnectorResult`; the router owns fallback.
- **DB injection is now transaction-wrapped** (Section 5.6) so a partial insert can never leave an orphaned paid order.
- **HMAC verification uses constant-time comparison** and notes Paymob's exact field-ordering requirement (Section 5.8).
- **Webhook idempotency keyed on payment status**, not on `payment_ref` presence (Section 5.8). Fixes the v1.0 contradiction.
- **Bilingual menu content + Arabic/RTL from Phase 1** (Sections 5.1, 5.3, 16). Not deferred to Phase 5.
- **Agent auto-update now requires signature verification** (Section 5.6 / 9).
- **Table identity clarified**: tag encodes a short `nfc_slug`; backend resolves it to a human-readable `label` ("Table 7") that is snapshotted onto the order and printed (Section 5.3).
- **New operational sections**: Venue Onboarding & Physical Deployment (Section 20), covering onboarding runbook, NFC+QR dual tags, image upload flow, and the demo venue.

---

## 0. Architecture Principles (Read Before Anything Else)

> From uploaded reference — these govern every decision in this spec:

- **Architecture is decisions, not diagrams.** Every structural choice below was made intentionally. Do not deviate without flagging a tradeoff.
- **Every architecture is a tradeoff.** This spec chooses simplicity and speed-to-market over theoretical elegance. Do not add complexity preemptively.
- **Boundaries first.** UI logic, business logic, data access, and POS integration are strictly separated. Never cross layers.
- **Data flow over technology.** Understand how an order moves from NFC tap → PWA → backend → payment → POS before touching implementation details.
- **Simplicity scales.** The simplest structure that satisfies requirements wins. Earn complexity with real needs.
- **Design for change.** POS connectors, payment providers, and menu structures will change. The adapter/router pattern exists for this reason.
- **If someone inherited this tomorrow, would they understand it?** Every naming decision, folder structure, and comment should answer yes.

---

## 1. Project Description

### What We Are Building
A multi-tenant, NFC-triggered progressive web app that allows dine-in customers to browse a restaurant menu, place an order, and pay via card — without visiting a cashier. Orders are routed automatically to the restaurant's existing POS system or kitchen printer. The platform targets Egyptian QSR and F&B chains.

### The Problem
- Customers queue at cashiers for dine-in orders
- Restaurants pay for extra cashier staff to handle order entry
- Third-party delivery platforms (Talabat) charge 25–35% commission and require manual retyping of orders into POS systems
- Most restaurants have no digital self-ordering channel for dine-in

### The Solution
- NFC tags on tables encode a URL: `app.taporder.io/order?venue=<slug>&table=<id>`
- Customer scans → PWA loads → browses menu → pays via Paymob → order routes to POS automatically
- Restaurant saves one cashier salary (EGP 3,000–5,000/month) vs. platform cost (EGP 2,500/month)
- No app install. No account required. Works on any modern phone.

### Target Market
Egyptian QSR chains on Foodics POS (primary), Vortex POS (secondary), and any POS via fallback print agent.

---

## 2. Business Requirements

| Requirement | Detail |
|---|---|
| Zero cashier touch for dine-in orders | Orders inject directly into POS or print to kitchen |
| Any restaurant can onboard | Fallback agent works regardless of POS |
| Customer pays card without moving | Paymob CNP via PWA |
| No app install for customer | PWA, browser-native |
| Real-time sold-out detection | Platform's own inventory layer |
| Multi-tenant | One codebase, unlimited venues |
| Restaurant has no website | PWA is their digital storefront |
| Operator rarely needs to intervene | Self-healing agent, auto-fallback, alerting |

---

## 3. Product Requirements

### Customer Flow
1. Scans NFC tag at table
2. Browser opens PWA with venue branding and menu
3. Adds items to cart
4. Enters name (no account required)
5. Paymob payment iframe loads
6. Pays by card
7. Sees order confirmation + estimated time
8. Receives order at table

### Restaurant Staff Flow
- Kitchen printer receives formatted ticket (fallback tier) OR
- POS screen shows order as if cashier entered it (integrated tier)
- Admin dashboard: mark items sold out, update stock count, view live orders

### Platform Admin (You) Flow
- Dashboard: all venues, agent status, order volume, alerts
- Venue onboarding: create venue, upload menu, configure POS connector
- Remote agent config push

---

## 4. System Architecture Overview

```
[NFC Tag — NTAG213]
        |
        | URL encoded: app.taporder.io/order?venue=<slug>&table=<id>
        ↓
[Customer Browser — PWA]
        |
        | HTTPS REST
        ↓
[Backend API — Node.js/Fastify]
        |
        |— GET /venues/:slug        → venue config, menu, branding
        |— POST /orders             → create pending order
        |— POST /webhooks/paymob    → payment confirmation
        |— WS  /agent/:venue_id     → on-premise agent connection
        ↓
[PostgreSQL — Primary DB]
[Redis — Cache + Pub/Sub]
        |
        ↓
[Order Router — Adapter Layer]
        |
   ┌────┴────────────────┐
   ↓                     ↓
[Foodics Connector]   [Agent Dispatcher]
(REST API over HTTPS)  (WebSocket to on-prem)
                          |
                     ┌────┴────────────┐
                     ↓                 ↓
              [DB Injector]      [ESC/POS Printer]
              (legacy POS DB)    (universal fallback)
```

---

## 5. Component Architecture

> **Code conventions (normative vs. illustrative).** Two things in this section are **normative** — implement them exactly: (1) the Prisma schema in 5.3, and (2) the TypeScript interfaces (`PosConnector`, `ConnectorResult`, `CanonicalOrder`). **Every other code block in this document is illustrative** — a sketch to convey intent, not drop-in code. Illustrative blocks may omit error handling, use placeholder helpers (e.g. `formatPrice`), and hardcode values that must come from config. Do not paste them verbatim. Where an illustrative block is security- or money-critical (HMAC, DB injection), the surrounding prose states the hard requirements that the real implementation must satisfy.

### 5.1 Frontend — PWA (Next.js)

**Responsibility**: Customer-facing ordering UI only. Stateless between sessions. No business logic.

**Stack**: Next.js 14 (App Router), Tailwind CSS, TypeScript

**Key Pages**:
- `/order` — main ordering page (venue slug + table from query params)
- `/order/confirm` — post-payment confirmation
- `/admin/[venue]` — restaurant staff admin (mark sold out, view orders)
- `/dashboard` — platform admin (you)

**PWA Config**:
- `next-pwa` with service worker for offline menu caching
- Web App Manifest for installability (optional, not required)
- NFC: no JS needed — tag encodes URL, browser handles the rest

**Internationalization (Phase 1, not deferred)**:
- `next-intl` configured from day one. Even if only English strings are populated initially, the wiring must exist.
- `dir="rtl"` driven by locale on the root layout; Tailwind `rtl:` utilities used for any directional spacing/alignment. Retrofitting RTL into a built-out component tree is far more expensive than starting with it.
- Locale resolved per venue (a venue's `default_locale`) with an optional in-PWA language toggle (Arabic / English).
- Menu content is bilingual at the data layer (see `MenuItem.name_ar` etc. in 5.3); the PWA renders the field matching the active locale and falls back to the other if one is empty.

**Multi-tenancy**:
- Venue slug from URL param hits `GET /venues/:slug`
- Response includes `branding: { primary_color, logo_url, name }`
- CSS variables set dynamically on mount — white-label feel per venue

**Paymob Integration**:
- Backend creates Paymob payment intention → returns checkout URL
- Frontend renders the Paymob checkout (card + Apple Pay surfaced automatically on capable devices)
- Paymob posts result to backend webhook (not frontend)
- Frontend polls `GET /orders/:id/status` every 3s until confirmed

> **iOS Safari caveat (must test explicitly).** Embedded iframes on iOS Safari have known failure modes — collapsed height, third-party cookie blocking under ITP, and payment redirects breaking out of the frame. Do **not** assume the embedded iframe "just works." Implement a fallback: if the iframe fails to load, or on iOS Safari by default, redirect to Paymob's **hosted checkout page** (full-page, same-tab) instead of embedding. Prefer Paymob's current recommended Unified Checkout over the legacy iframe. This is ~1 day of work if specced now and a demo-day fire if discovered later.

**State Management**: React Context only — cart state, venue config. No Redux. No persistence needed (guest checkout, stateless).

---

### 5.2 Backend API — Node.js/Fastify

**Responsibility**: Business logic, order orchestration, payment handling, agent communication, POS routing.

**Stack**: Node.js, Fastify, TypeScript, Prisma ORM

**Why Fastify over Express**: Native TypeScript, schema validation built in, faster, WebSocket support via `@fastify/websocket`.

**Folder Structure**:
```
src/
  routes/           # HTTP route handlers (thin — no logic here)
  services/         # Business logic (orders, venues, inventory)
  connectors/       # POS adapter implementations
    foodics.ts
    db-injector.ts
    print-agent.ts
    router.ts       # The adapter router (switch statement)
  agents/           # WebSocket agent manager
  webhooks/         # Paymob webhook handler
  middleware/       # Auth, rate limiting, logging
  lib/              # DB client, Redis client, Paymob client
  types/            # Shared TypeScript types/interfaces
```

**Core API Endpoints**:
```
GET  /venues/:slug                    → venue config + menu (cached)
POST /orders                          → create order (status: CREATED; reserves stock)
GET  /orders/:id/status               → poll for confirmation
POST /orders/:id/cancel               → customer cancel (before CONFIRMED / grace window)
POST /webhooks/paymob                 → payment result → confirm + route
POST /admin/venues/:id/items/:sku/toggle → mark item available/unavailable
POST /admin/venues/:id/orders/:oid/cancel  → staff cancel (refunds if paid)
POST /admin/venues/:id/orders/:oid/collect → staff mark cash order collected (payment PAID)
GET  /admin/venues/:id/orders         → live order feed (SSE)
WS   /agent/connect                   → on-premise agent persistent connection
GET  /platform/agents                 → agent health dashboard (you)
```

**Order Lifecycle** — this is the single source of truth. It is referenced by Sections 5.7, 5.8, 5.9, 14, and 15. Do not redefine states anywhere else.

Two orthogonal concerns are tracked on every order:
- **`status` (fulfillment lifecycle)** — where the order is in the prepare-and-deliver pipeline.
- **`payment_status` (money lifecycle)** — whether the customer's money has been taken / returned.

This separation exists because cash is paid *after* fulfillment and refunds *un-pay* an already-paid order — a single combined enum cannot represent either.

```
FULFILLMENT (status):

  CREATED
    │  (online: card/applepay)            (cash)
    ├──────────────► PAYMENT_PENDING        │
    │                     │ paid webhook    │ accepted
    │                     ▼                 ▼
    │                 CONFIRMED ◄───────────┘
    │                     │  routeOrder()
    │                     ▼
    │                  ROUTING
    │             ┌───────┴────────┐
    │             ▼                ▼
    │         INJECTED          PRINTED
    │             └───────┬────────┘
    │                     ▼
    │                 FULFILLED
    │
    ├──► EXPIRED      (online payment never completed within TTL → release stock)
    ├──► CANCELLED    (cancelled before FULFILLED → release stock; refund if already paid)
    └──► FAILED       (all connectors failed → alert + refund if paid)

PAYMENT (payment_status):  UNPAID → PAID → (REFUNDED | VOIDED)
```

- Routing is triggered when an order reaches **`CONFIRMED`** — for online orders that is the verified Paymob webhook; for cash it is staff/auto acceptance.
- `CONFIRMED` replaces v1.0's overloaded `PAID` status. Whether money was taken now lives in `payment_status`, not `status`.

---

### 5.3 Database — PostgreSQL

**Host**: Managed PostgreSQL (Supabase free tier for MVP, migrate to Hetzner managed DB at scale)

**ORM**: Prisma (type-safe, migrations built in, readable schema)

**Schema**:

```prisma
model Venue {
  id              String   @id @default(uuid())
  slug            String   @unique
  name            String
  logo_url        String?
  primary_color   String   @default("#000000")
  default_locale  String   @default("ar")   // "ar" | "en" — Egyptian market defaults to Arabic
  pos_type        PosType  @default(PRINT_FALLBACK)
  pos_credentials Json?    // encrypted at app level before storage
  db_config       Json?    // encrypted — for DB injector tier
  paymob_config   Json?    // encrypted — per-venue Paymob keys (see 5.8). Money settles to the venue, not the platform.
  stock_buffer    Int      @default(0)  // show item unavailable when stock_count <= this (oversell guard)
  active          Boolean  @default(true)
  created_at      DateTime @default(now())

  tables          Table[]
  menu_items      MenuItem[]
  orders          Order[]
  agents          Agent[]
}

model Table {
  id        String  @id @default(uuid())
  venue_id  String
  label     String  // human-readable, printed on the kitchen ticket: "Table 7", "Counter 2"
  nfc_slug  String  @unique // SHORT code encoded on the tag + QR (e.g. "t7"). NOT the uuid. Resolves to `label`.
  venue     Venue   @relation(fields: [venue_id], references: [id])
}

model MenuItem {
  id             String   @id @default(uuid())
  venue_id       String
  sku            String   // your internal SKU
  pos_sku        String?  // their POS product code (for injection)
  name           String   // primary/English name
  name_ar        String?  // Arabic name (rendered when locale = ar)
  description    String?
  description_ar String?
  price          Int      // in piastres (avoid floats). TAX-INCLUSIVE final price (see 5.8).
  category       String
  category_ar    String?
  available      Boolean  @default(true)
  stock_count    Int?     // null = unlimited
  reserved_count Int      @default(0)  // held by unpaid/in-flight orders (see 5.7)
  image_url      String?
  venue          Venue    @relation(fields: [venue_id], references: [id])
}

model Order {
  id             String        @id @default(uuid())
  venue_id       String
  table_label    String        // snapshot of Table.label at order time — this is what prints on the ticket
  customer_name  String?
  customer_phone String?       // optional — enables "order ready" WhatsApp/SMS and reaching the customer on failure
  items          Json          // snapshot of ordered items + prices
  total          Int           // piastres, tax-inclusive
  status         OrderStatus   @default(CREATED)
  payment_method PaymentMethod @default(CARD)
  payment_status PaymentStatus @default(UNPAID)
  payment_ref    String?       // Paymob transaction ID (online only)
  refund_ref     String?       // Paymob refund/void transaction ID
  pos_ref        String?       // POS order ID if injected
  routing_tier   String?       // which connector handled it
  cancel_reason  String?
  paid_at        DateTime?     // online: webhook time; cash: when staff marks collected
  created_at     DateTime      @default(now())
  updated_at     DateTime      @updatedAt
  venue          Venue         @relation(fields: [venue_id], references: [id])
}

model Agent {
  id              String    @id @default(uuid())
  venue_id        String    @unique
  last_heartbeat  DateTime?
  status          AgentStatus @default(OFFLINE)
  current_tier    String?   // 'db_injector' | 'print_fallback'
  schema_ok       Boolean   @default(true)
  venue           Venue     @relation(fields: [venue_id], references: [id])
}

enum PosType {
  FOODICS
  DB_INJECTOR
  PRINT_FALLBACK
}

// Fulfillment lifecycle — see the canonical state machine in 5.2. Do not redefine elsewhere.
enum OrderStatus {
  CREATED
  PAYMENT_PENDING   // online only: Paymob checkout shown, awaiting payment
  CONFIRMED         // ready to route (online: paid webhook; cash: accepted). Triggers routeOrder().
  ROUTING
  INJECTED
  PRINTED
  FULFILLED
  CANCELLED         // cancelled before fulfillment
  FAILED            // all connectors failed
  EXPIRED           // online payment never completed within TTL
}

enum PaymentMethod {
  CARD              // via Paymob
  APPLE_PAY         // via Paymob (same intention as CARD; surfaced on Apple devices)
  CASH              // collected at the table on delivery; no online charge
}

enum PaymentStatus {
  UNPAID            // not yet paid (all cash orders start here; online before webhook)
  PAID              // online: webhook verified; cash: staff marked collected
  REFUNDED          // money returned after settlement
  VOIDED            // money released before settlement (Paymob void)
}

enum AgentStatus {
  ONLINE
  OFFLINE
  DEGRADED  // online but on fallback tier
}
```

---

### 5.4 The Order Router (Adapter Layer)

This is the most critical component. It must never have UI logic, payment logic, or DB queries — it only decides where an order goes and delegates. **The router owns the fallback chain. Connectors are pure: they attempt one thing, succeed or fail, and report back. A connector never knows about or calls another connector.** This keeps the "never let a paid order disappear" guarantee in one place and means adding a new connector cannot accidentally break fallback.

```typescript
// src/connectors/router.ts  [NORMATIVE shape — implement this pattern]

import { foodicsConnector } from './foodics';
import { dbInjector } from './db-injector';
import { printAgent } from './print-agent';
import { CanonicalOrder, Venue, PosConnector } from '../types';

// The chain is ordered: try the primary tier, fall back to print as the safety net.
function buildChain(venue: Venue): PosConnector[] {
  switch (venue.pos_type) {
    case 'FOODICS':      return [foodicsConnector, printAgent];
    case 'DB_INJECTOR':  return [dbInjector, printAgent];
    case 'PRINT_FALLBACK':
    default:             return [printAgent];
  }
}

export async function routeOrder(order: CanonicalOrder, venue: Venue): Promise<void> {
  const chain = buildChain(venue);
  for (const connector of chain) {
    const result = await connector.inject(order, venue);
    if (result.ok) {
      // persist status = result.tier === 'print' ? PRINTED : INJECTED, pos_ref, routing_tier
      return;
    }
    log.warn({ order_id: order.id, connector: connector.name, error: result.error });
  }
  // Every connector failed. Mark FAILED, alert immediately, and (if paid online) trigger refund — see 5.9.
  throw new AllConnectorsFailedError(order.id);
}
```

Every connector implements the same interface and **returns** a result rather than throwing for expected failures (it may throw only on programmer error):
```typescript
// NORMATIVE
interface PosConnector {
  readonly name: string;
  inject(order: CanonicalOrder, venue: Venue): Promise<ConnectorResult>;
}

interface ConnectorResult {
  ok: boolean;
  tier: 'foodics' | 'db_injector' | 'print';
  pos_ref?: string;   // POS order id on success
  error?: string;     // human-readable reason on failure
}
```

> Note: `printAgent` implements `PosConnector` like every other connector (v1.0 gave it a non-conforming `send()` method — that was an exception to the "no exceptions" rule in Section 19 and is removed).

**CanonicalOrder** (your internal format — never changes regardless of POS). All money fields are integer piastres and **tax-inclusive** (see 5.8: the POS owns the tax breakdown; TapOrder only carries the final amount the customer pays):
```typescript
// NORMATIVE
interface CanonicalOrder {
  id: string;
  venue_id: string;
  table: string;              // human-readable label ("Table 7") — snapshotted, prints on the ticket
  customer_name?: string;
  payment_method: 'CARD' | 'APPLE_PAY' | 'CASH';
  payment_status: 'UNPAID' | 'PAID' | 'REFUNDED' | 'VOIDED';
  items: Array<{
    sku: string;
    pos_sku?: string;
    name: string;
    qty: number;
    unit_price: number;       // tax-inclusive
  }>;
  total: number;              // tax-inclusive sum
  paid_at?: string;           // absent for unpaid cash orders
  payment_ref?: string;       // absent for cash
}
```

> Cash orders carry `payment_method: 'CASH'` and `payment_status: 'UNPAID'` when routed. The connector flags the ticket/POS order as **"CASH — collect EGP X at table"** so staff know to collect. `payment_status` flips to `PAID` when staff mark it collected.

---

### 5.5 Foodics Connector

**Auth**: OAuth2 — venue admin clicks "Connect Foodics" → Foodics OAuth consent → you store access token + refresh token encrypted in `venues.pos_credentials`

**Token refresh**: Handled automatically by connector before each request. Store expiry timestamp alongside token.

**Per-order flow**:
1. `GET /api/v5/branches/:branch_id/products` — resolve your SKUs to Foodics product IDs (cache this, invalidate daily)
2. `POST /api/v5/orders` — inject order with Foodics product IDs, table reference, total
3. Parse response for Foodics order ID → store in `orders.pos_ref`
4. Foodics handles inventory decrement, kitchen display, everything

**Error handling** (connector returns a `ConnectorResult`; it never calls the print agent itself — the router does that):
- 401 → attempt token refresh → retry once → on still-failure return `{ ok: false, tier: 'foodics', error }`
- 422 (item not found) → log SKU mismatch → return `{ ok: false, ... }`
- 5xx → retry with exponential backoff (3 attempts) → return `{ ok: false, ... }`

**Fallback rule**: The router (5.4) sees `ok: false` and advances to the next connector in the chain (print agent). The connector's only job is to try Foodics and report the outcome. Never let a paid order disappear — but that guarantee lives in the router, not here.

---

### 5.6 On-Premise Agent

A Node.js process running on a Windows PC or Raspberry Pi at the restaurant. Packaged as:
- **Windows**: `node-windows` service, auto-starts on boot, system tray icon
- **Raspberry Pi**: `pm2` process manager, starts on boot

**Agent responsibilities**:
1. WebSocket connection to `wss://api.taporder.io/agent/connect` with venue API key auth
2. Heartbeat ping every 30 seconds (backend tracks `last_heartbeat`)
3. Receive order payloads from backend
4. Attempt DB injection if configured
5. Fall back to ESC/POS print on any failure
6. Report result back to backend (success/failure/which tier used)
7. Schema health check on startup and every hour

**Agent WebSocket protocol**:
```
Backend → Agent:  { type: "ORDER", payload: CanonicalOrder }
Agent → Backend:  { type: "HEARTBEAT", venue_id, schema_ok, printer_ok }
Agent → Backend:  { type: "ORDER_RESULT", order_id, status: "injected"|"printed"|"failed", tier }
Backend → Agent:  { type: "CONFIG_UPDATE", config: PosSchemaConfig }
```

**DB Injector (inside agent)** — *illustrative*. The hard requirements the real implementation must satisfy: (1) the order header insert and **all** line-item inserts happen inside **one transaction** that rolls back entirely on any failure — a partial write (header inserted, items not) must never persist; (2) parameterized queries only, never string concatenation; (3) a schema-version hash is checked before injecting — if it changed since the config was mapped, skip injection and fall back to print + alert (see 5.6 schema health check):
```typescript
// ILLUSTRATIVE — not drop-in. Transaction wrapping and the schema guard are mandatory.
const config = loadPosConfig(venue.pos_type); // e.g. "vortex_v3"

async function injectToDb(order: CanonicalOrder, dbConfig: DbConfig): Promise<ConnectorResult> {
  const db = await connectDb(dbConfig); // mssql or mysql2 driver
  const tx = await db.beginTransaction();
  try {
    if (await currentSchemaHash(db, config) !== config.schema_hash) {
      await tx.rollback();
      return { ok: false, tier: 'db_injector', error: 'schema_drift' }; // router → print fallback
    }
    const productIds = await resolveSkus(tx, config, order.items);

    const orderId = await tx.query(
      `INSERT INTO ${config.tables.orders} (...) VALUES (...)`,   // parameterized
      buildOrderParams(order, config)
    );
    for (const item of order.items) {
      await tx.query(
        `INSERT INTO ${config.tables.order_items} (...) VALUES (...)`, // parameterized
        buildItemParams(item, orderId, productIds, config)
      );
    }
    await tx.commit();
    return { ok: true, tier: 'db_injector', pos_ref: String(orderId) };
  } catch (err) {
    await tx.rollback(); // header + items both gone — no orphaned paid order
    return { ok: false, tier: 'db_injector', error: String(err) };
  }
}
```

**POS Schema Config** (one file per POS version, stored in your backend, pushed to agent):
```json
{
  "pos_type": "vortex_v3",
  "db_driver": "mssql",
  "schema_hash": "sha256:...",
  "tables": {
    "orders": "tbl_orders",
    "order_items": "tbl_order_lines",
    "products": "tbl_products"
  },
  "field_mapping": {
    "order_total": "total_amount",
    "table_number": "section_ref",
    "item_sku": "product_code",
    "item_qty": "quantity",
    "item_price": "unit_price"
  },
  "status_codes": { "new": 1, "paid": 3 },
  "required_defaults": { "cashier_id": 0, "order_type": 2 }
}
```

> **Legal / consent prerequisite for the DB injector tier.** Writing into a third-party POS database is governed by that vendor's EULA and is legally sensitive. TapOrder only enables this tier for a venue after the **venue owner** (who holds the POS license and owns the data) gives **written authorization** as part of onboarding (Section 20). This is a contractual gate, not a quiet technical capability. If Vortex (or any vendor) pushes an update that changes the schema, the `schema_hash` check above forces an immediate fallback to print rather than a blind write. Document this tier's limitations honestly to the owner before enabling it.

**ESC/POS Print fallback (inside agent)** — *illustrative*. Real version: printer host/port come from agent config (not hardcoded), `formatPrice` is a helper that renders piastres as EGP, and unpaid cash orders print a "collect at table" banner so staff know to take payment:
```typescript
// ILLUSTRATIVE
import { ThermalPrinter, PrinterTypes } from 'node-thermal-printer';

async function printTicket(order: CanonicalOrder, cfg: AgentConfig): Promise<ConnectorResult> {
  const printer = new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: `tcp://${cfg.printerHost}:${cfg.printerPort}`, // from agent config, not hardcoded
  });

  printer.alignCenter();
  printer.bold(true);
  printer.println(order.table);                 // "Table 7" — server delivers here
  printer.bold(false);
  printer.println(`Order #${order.id.slice(-6).toUpperCase()}`);
  printer.drawLine();

  for (const item of order.items) {
    printer.leftRight(`${item.qty}x ${item.name}`, formatPrice(item.unit_price));
  }

  printer.drawLine();
  printer.leftRight('TOTAL', formatPrice(order.total));

  if (order.payment_method === 'CASH' && order.payment_status === 'UNPAID') {
    printer.bold(true);
    printer.println(`*** CASH — COLLECT ${formatPrice(order.total)} AT TABLE ***`);
    printer.bold(false);
  } else {
    printer.println(`PAID — ${order.payment_ref?.slice(-8) ?? ''}`);
  }
  printer.cut();
  await printer.execute();
  return { ok: true, tier: 'print' };
}
```

---

### 5.7 Inventory Layer

Your platform maintains its own inventory, independent of the POS.

**Reserve → commit → release model** (this replaces v1.0's "decrement at order creation," which permanently sold out items every time a customer abandoned an unpaid cart):

- On venue onboarding, staff sets `stock_count` per item (null = unlimited).
- **Reserve at order creation**: `reserved_count += qty` (the item is held, not yet sold). Availability is computed as `stock_count - reserved_count`.
- **Commit on `CONFIRMED`**: when the order is confirmed (online payment verified, or cash accepted), `stock_count -= qty` and `reserved_count -= qty`. The sale is now real.
- **Release on `EXPIRED` / `CANCELLED`**: `reserved_count -= qty` (and if it had already been committed, `stock_count += qty` — i.e. a cancelled paid order restocks). An abandoned cart releases its hold on payment timeout (TTL, e.g. 10 min) and never touches `stock_count`.
- When effective availability hits 0, `available` flips to `false` automatically.
- PWA polls `GET /venues/:slug` every 60s for availability (or SSE for real-time).
- Staff admin page has one-tap "Mark Sold Out" / "Mark Available" per item, which invalidates the cache immediately.
- **Oversell buffer** (`venue.stock_buffer`): show an item as unavailable when effective availability `<= stock_buffer`. This is a band-aid for walk-in customers ordering at the counter on a POS your platform can't see — see the known-limitation note below.

**Race condition protection**: Reserve and commit both run inside a Postgres transaction with `SELECT ... FOR UPDATE` on the affected `menu_items` rows. Two simultaneous orders for the last unit cannot both reserve it.

> **Known limitation (Phase 1, document honestly to the owner).** Your inventory and the restaurant's POS will diverge for **print-fallback venues**: a walk-in ordering the last item at the counter doesn't decrement your count, so a subsequent NFC order can oversell. The buffer rule mitigates but does not eliminate this. For Foodics/DB-injector venues this is less acute (the POS is the source of truth and you can later sync). The proper fix — polling POS inventory, or relying on staff to keep your admin panel current — is deferred. State this limitation in the onboarding agreement.

---

### 5.8 Payment — Paymob

**Money flow — the platform never holds restaurant funds.** Each venue connects **its own Paymob account**; customer payments settle **directly to the restaurant**. TapOrder takes its cut one of two ways:

- **Default — flat SaaS fee.** The restaurant pays the monthly subscription (≈EGP 2,500) separately, billed by you. Payments for orders go straight to their Paymob account; you are never in the money path. Lowest regulatory exposure — you are a software vendor, not a money handler.
- **Optional — per-order commission via Paymob Split Payment.** If you want a percentage of each order instead of (or alongside) the flat fee, Paymob's Split Payment feature splits each transaction at settlement: the restaurant gets their share and you get your commission automatically, without you ever holding their money. Enable per venue when the commission model is wanted.

> Per-venue Paymob keys live in `venues.paymob_config` (encrypted, AES-256-GCM, like `pos_credentials`). The single global `PAYMOB_*` env vars from v1.0 are removed — they implied one platform account collecting everyone's money, which is the thing we're avoiding. (You may still keep one Paymob account for the **demo venue** only; see Section 20.)
>
> *Not legal/financial advice — confirm the licensing treatment of the commission model in Egypt before enabling Split Payment. The flat-fee model keeps you clearly out of the money-transmission question.*

**Tax:** TapOrder does **not** compute tax. Menu prices are **final, tax-inclusive** prices (the norm for displayed F&B prices in Egypt), and the POS remains the source of truth for the tax/service breakdown on its own records. The only hard requirement is that **the amount charged equals the total the POS will record** so the restaurant's settlement reconciles with their books. Verify at onboarding that the venue's POS product prices are configured tax-inclusive (or that its tax handling matches the displayed prices). That's a one-line onboarding check, not a tax engine.

#### Payment methods

| Method | Path | Notes |
|---|---|---|
| **Card** | Paymob checkout | Standard CNP card payment. |
| **Apple Pay** | Paymob checkout | Same payment intention as card — Paymob surfaces Apple Pay automatically on Safari/Apple devices. Requires a one-time **Apple Pay domain verification** with Apple for `app.taporder.io`. No separate code path; it's a method inside the same checkout. |
| **Cash** | Offline | No online charge. Order is created `UNPAID`, confirmed (auto or staff-accept), routed to kitchen/POS with a **"CASH — collect at table"** flag. Staff collect on delivery and mark `PAID` in admin (which sets `paid_at`). No refund API applies — cancellation of an unpaid cash order is just `CANCELLED`. |

Card and Apple Pay are one integration; the customer's method choice only changes which buttons Paymob renders. Cash is the genuinely separate path because it skips Paymob entirely and is paid after fulfillment.

#### Online flow (card / Apple Pay)
1. `POST /orders` → creates order `status: CREATED`, `payment_status: UNPAID`, reserves stock (5.7)
2. Backend calls the **venue's** Paymob account → creates payment intention → gets checkout URL
3. Returns `{ order_id, paymob_checkout_url }`; order → `PAYMENT_PENDING`
4. Frontend renders Paymob checkout (iframe with hosted-page fallback — see 5.1)
5. Customer pays
6. Paymob POSTs to `POST /webhooks/paymob` with HMAC signature
7. Backend verifies HMAC → sets `payment_status: PAID`, `paid_at`, order → `CONFIRMED` → commits stock → `routeOrder()`
8. Frontend polling detects `CONFIRMED` → shows confirmation

#### Cash flow
1. `POST /orders` with `payment_method: CASH` → `status: CREATED`, `payment_status: UNPAID`, reserves stock
2. Order is confirmed (MVP: auto-confirm; optional: venue requires staff tap-to-accept to deter no-shows) → `CONFIRMED` → commit stock → `routeOrder()` with the cash flag
3. Staff deliver, collect cash, tap "Mark collected" → `payment_status: PAID`, `paid_at` set
4. `FULFILLED`

**HMAC Verification** (never skip; constant-time compare):
```typescript
// ILLUSTRATIVE — the field-ordering of buildHmacString is the part most often done wrong.
// Paymob requires specific transaction fields concatenated in Paymob's documented exact order.
import crypto from 'crypto';

const expected = crypto
  .createHmac('sha512', venuePaymobHmacSecret)            // per-venue secret
  .update(buildHmacString(webhookBody))                    // exact field order per Paymob docs
  .digest('hex');

const a = Buffer.from(expected, 'hex');
const b = Buffer.from(webhookBody.hmac, 'hex');
if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
  throw new Error('Invalid webhook signature'); // do NOT use !== on the hex strings (timing leak)
}
```

**Idempotency**: Paymob may send duplicate webhooks. Key idempotency on **payment status**, not on `payment_ref` presence: if the order is already `payment_status: PAID`, return 200 and skip. (v1.0 said "skip if `payment_ref` is set" — but `payment_ref` may be set at intention-creation, which would wrongly skip the first real webhook.) Never process the same payment twice.

---

### 5.9 Cancellation & Refunds

Two reversal paths, both ending in a terminal state from the canonical machine (5.2). Who can do what, and when, is deliberately constrained — a customer must not be able to cancel after the kitchen has started.

**Who can cancel**
| Actor | When allowed | Effect |
|---|---|---|
| Customer | Only before `CONFIRMED` (i.e. `CREATED` / `PAYMENT_PENDING`), or within a short grace window right after payment if the venue enables it | Online unpaid → `CANCELLED`. Paid-in-grace → `CANCELLED` + refund. Cash unpaid → `CANCELLED`. |
| Venue staff | Any time before `FULFILLED` (e.g. item ran out, kitchen can't make it) | `CANCELLED`; if online-paid, auto-refund. |
| System | Online payment never completes within TTL | `EXPIRED`, release reservation (5.7). No money involved. |
| System | All connectors failed (5.4) | `FAILED`, alert, then refund if paid. |

**Refund / void rules (online orders only — cash has nothing to refund):**
- Use Paymob's **Void** API if the transaction has not yet settled (same-day, pre-settlement) → `payment_status: VOIDED`. Cheaper/cleaner than a refund.
- Use Paymob's **Refund** API after settlement → `payment_status: REFUNDED`.
- Store the Paymob reversal id in `orders.refund_ref`.
- A refunded/cancelled order **restocks** its items (5.7: `stock_count += qty`).
- Refunds go back to the original card/Apple Pay automatically — but the customer may have walked away, so if `customer_phone` is present, send an "order cancelled & refunded" message.

**`FAILED` → refund is automatic.** When `routeOrder()` exhausts the chain: alert you immediately, attempt one last print as a safety net, and if the order was paid online, trigger the refund/void so a customer is never charged for food they won't get. This closes the v1.0 gap where a fully-failed paid order sat in `FAILED` with the money gone.

**Add to `OrderStatus`**: `CANCELLED`, `FAILED`, `EXPIRED` (done in 5.3). **Payment reversal** lives in `payment_status`: `REFUNDED` / `VOIDED`.

**Endpoints** (added to 5.2's API list):
```
POST /orders/:id/cancel              → customer cancel (server enforces the "before CONFIRMED / grace" rule)
POST /admin/venues/:id/orders/:oid/cancel → staff cancel (any time before FULFILLED) → triggers refund if paid
POST /admin/venues/:id/orders/:oid/collect → staff mark cash order collected → payment_status PAID
```

---



## 6. Auth & Permissions

**Three roles**:

| Role | Access | Auth Method |
|---|---|---|
| Customer | PWA only, no auth | None (guest) |
| Venue Staff | Admin panel for their venue | Email/password + JWT, venue-scoped |
| Platform Admin (you) | All venues, agent dashboard | Email/password + JWT + admin flag |

**JWT**: Short-lived access tokens (15min) + refresh tokens (7 days) stored in httpOnly cookies. Never localStorage.

> **Cross-subdomain cookie note.** PWA on `app.taporder.io`, API on `api.taporder.io` → set the cookie `Domain=taporder.io` so it's shared across subdomains, with `SameSite=None; Secure`. Watch two footguns: (1) during local dev the PWA may run on a `*.vercel.app` preview while the API is on `api.taporder.io` — different root domains, so the shared-domain cookie won't apply and auth will appear "broken" locally; use a local proxy or matching dev domains. (2) `SameSite=None` requires `Secure`, so cookies won't set over plain HTTP — always test auth over HTTPS.

**Venue scoping**: Every staff request validated server-side: `WHERE venue_id = jwt.venue_id`. Staff cannot access another venue's data even if they guess the endpoint.

**Agent auth**: Each agent has a static API key (UUID) stored in agent config file. Sent as `Authorization: Bearer <key>` on WebSocket upgrade. Rotatable from platform dashboard.

**Paymob webhook**: HMAC verification as above. No JWT needed — Paymob calls this, not a user.

---

## 7. Hosting & Deployment

### MVP (Launch)
| Component | Host | Cost |
|---|---|---|
| Backend API | Hetzner VPS CX21 (2 core, 4GB) | ~€5/month |
| PostgreSQL | Supabase free tier | Free |
| Redis | Upstash free tier | Free |
| PWA Frontend | Vercel free tier | Free |
| Agent (per restaurant) | Restaurant's PC or Raspberry Pi 4 | ~$35 one-time hardware |

### Scale (20+ venues)
| Component | Host |
|---|---|
| Backend API | Hetzner CX41, or 2x CX21 behind Nginx |
| PostgreSQL | Hetzner managed DB |
| Redis | Upstash Pro or self-hosted on separate VPS |
| PWA | Vercel (scales automatically) |
| Agent | Same — scales independently per restaurant |

---

## 8. Cloud & Compute

**Backend**: Single VPS initially. Fastify handles thousands of concurrent requests on 2 cores — you will not need horizontal scaling for the first 50 venues. Do not over-engineer this.

**WebSocket Agent Connections**: Fastify WebSocket via `@fastify/websocket`. Each agent = one persistent connection. 50 restaurants = 50 connections. Trivial load.

**Redis Pub/Sub**: Used for:
- Distributing order events to the correct WebSocket connection when running multiple backend instances (needed at scale, not MVP)
- Caching venue config + menu (TTL: 60s, invalidated on menu update)

**Background Jobs**: Use `node-cron` for:
- Daily Foodics product cache refresh
- Hourly agent health check sweep (mark agents OFFLINE if no heartbeat in 90s)
- EOD order summary email to venue admins

---

## 9. CI/CD & Version Control

**Repository structure**:
```
taporder/
  apps/
    web/        # Next.js PWA
    api/        # Fastify backend
    agent/      # On-premise agent
  packages/
    types/      # Shared TypeScript types
    pos-configs/ # POS schema config JSON files
```

**Monorepo**: Turborepo. All three apps share the `types` package — canonical order schema is defined once.

**Branching**: `main` (production), `dev` (staging), feature branches.

**GitHub Actions**:
```yaml
# On push to main:
- Run TypeScript type check
- Run tests (Vitest)
- Build Docker image for API
- Push to GitHub Container Registry
- SSH to Hetzner VPS, pull new image, restart container

# On push to dev:
- Same but deploys to staging environment
```

**Agent deployment**: Agent is packaged as a distributable `.exe` (Windows, via `pkg`) or `.tar.gz` (Pi). New versions pushed via GitHub Releases. Agent checks for updates on startup.

> **Auto-update is a supply-chain attack surface — sign the binaries.** "Download newer release and run it" means a compromised GitHub account could run attacker code on every restaurant PC you've deployed to. The agent **must verify a detached signature over the binary's SHA-256, signed with your private release key, before executing it** — reject and alert on mismatch. Additional hardening: pin to an expected version range, stage/canary updates rather than pushing to all agents at once, and apply the update on the next scheduled restart rather than swapping a running process mid-order. The signing public key ships inside the agent build (`AGENT_UPDATE_PUBLIC_KEY`), never the private key.

---

## 10. Security

**In transit**: HTTPS everywhere. TLS 1.2+ enforced. WebSocket connections over WSS only.

**At rest**:
- `pos_credentials` and `db_config` encrypted at application level (AES-256-GCM) before storage. Encryption key in environment variable, never in DB.
- Passwords hashed with bcrypt (12 rounds)
- No card data ever touches your servers — Paymob handles PCI compliance via iframe

**SQL Injection**: Prisma ORM parameterizes all queries. DB injector agent uses parameterized queries only — never string concatenation.

**Input validation**: Fastify JSON schema validation on every endpoint. Requests failing schema validation rejected at the route level before reaching business logic.

**Secrets**: All secrets in environment variables. `.env` never committed. Use Hetzner environment config or GitHub Actions secrets for CI.

**CORS**: Whitelist `app.taporder.io` only. No wildcard origins.

**Agent security**: API key auth, WSS only, keys rotatable from dashboard, agent cannot read from your DB — it only receives order payloads pushed to it.

---

## 11. Rate Limiting

**Library**: `@fastify/rate-limit` with Redis store (shared across instances at scale)

**Limits**:
```
POST /orders              → 10 req/min per IP (prevents cart spam)
POST /webhooks/paymob     → 100 req/min (Paymob IPs only, whitelist their IP range)
GET  /venues/:slug        → 60 req/min per IP (menu browsing)
POST /admin/*             → 30 req/min per authenticated user
WS   /agent/connect       → 5 connection attempts/min per API key
```

**429 response**: Return `{ error: "rate_limit_exceeded", retry_after: 60 }` with `Retry-After` header.

---

## 12. Caching & CDN

**Redis** (Upstash):
- `venue:{slug}` → full venue config + menu. TTL: 60s. Invalidated on any menu update.
- `foodics_products:{venue_id}` → Foodics product ID map. TTL: 24h. Invalidated on manual refresh.

**Why 60s TTL on menu**: Balances freshness (sold-out items) vs. DB load. Staff "mark sold out" action explicitly invalidates the cache key immediately — so real-time accuracy is maintained for the most important use case.

**CDN**: Vercel Edge Network handles PWA static assets globally. No additional CDN needed.

**Menu images**: Store on Cloudflare R2 (S3-compatible, free egress). URLs referenced in `menu_items.image_url`.

---

## 13. Load Balancing & Scaling

**MVP**: Single Fastify instance on one VPS. Nginx as reverse proxy in front (handles TLS termination, HTTP→HTTPS redirect, WebSocket upgrade headers).

**Nginx config for WebSocket**:
```nginx
location /agent/ {
  proxy_pass http://localhost:3000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_read_timeout 3600s; # persistent connection
}
```

**Horizontal scaling trigger**: When CPU on VPS sustains above 70% or memory above 80%. Add a second VPS + Nginx upstream load balancing. Redis Pub/Sub handles WebSocket event distribution across instances.

**DB connection pooling**: Prisma connection pool (default 10 connections). Supabase/Hetzner managed DB handles the rest.

---

## 14. Error Tracking & Logs

**Error tracking**: Sentry (free tier for MVP). Captures unhandled exceptions in backend and frontend. Agent errors reported via WebSocket back to backend, then to Sentry.

**Structured logging**: `pino` (built into Fastify). Every log line is JSON:
```json
{ "level": "info", "order_id": "uuid", "venue_id": "uuid", "event": "order_routed", "tier": "foodics", "ms": 234 }
```

**What to log**:
- Every order state transition (with order_id, venue_id, timestamp)
- Every connector attempt + result (including which tier)
- Every agent heartbeat gap > 90s
- Every Paymob webhook received + HMAC result
- Every fallback activation (DB injection failed → printed instead)

**Alerting**: Sentry alerts + simple email/Slack webhook for:
- Agent offline > 5 minutes
- Order stuck in ROUTING status > 2 minutes
- Paymob webhook HMAC failure (potential attack)
- Any venue's error rate > 5% in a 10-minute window

---

## 15. High Availability & Recovery

**Database**:
- Supabase (MVP): daily automated backups, point-in-time recovery
- Hetzner Managed DB (scale): automated backups + read replicas

**Agent self-healing**:
- WebSocket auto-reconnects with exponential backoff (1s, 2s, 4s, max 30s)
- DB injection failure → automatically falls back to print → reports degraded status
- Schema health check on startup — if schema mismatch detected, skips DB injection, goes straight to print, sends alert
- Agent never crashes silently — all errors reported to backend

**Order safety net**: Every confirmed order that fails routing (all connectors in the chain fail) is flagged `FAILED` and:
1. Alert sent to you immediately
2. Fallback print attempted (last resort)
3. Venue staff sees it in admin dashboard in real-time
4. If it was paid online, a refund/void is triggered automatically (5.9) — a customer is never charged for food they won't get

**Payment safety**: Paymob webhook idempotency ensures a network retry never double-processes a payment. `payment_status` is checked before processing — if already `PAID`, return 200 silently.

**No SPOF for customer-facing flow**: The PWA is on Vercel (near-zero downtime). If your backend is down, the customer sees a friendly error — no payment is taken (Paymob iframe won't load). This is acceptable at MVP scale.

---

## 16. Phased Implementation Plan

> Each phase is a Claude Code session. Paste the relevant phase brief + this full spec at the start of every session.

---

### Phase 1 — Core Platform (Weeks 1–3)

**Goal**: A working end-to-end order flow with print fallback. One venue can take orders and receive printed tickets.

**What to build**:

1. **Monorepo setup**: Turborepo, three apps (`web`, `api`, `agent`), shared `types` package. TypeScript throughout.

2. **Database**: Prisma schema (Section 5.3). Run initial migration. Seed one test venue with bilingual menu items and tables (short `nfc_slug` per table).

3. **i18n/RTL scaffolding**: `next-intl` wired in, `dir="rtl"` driven by locale, Tailwind `rtl:` utilities in the layout. English + Arabic string files (Arabic can start sparse). This is cheap now and brutal to retrofit — do it in Phase 1.

4. **Backend API — core routes**:
   - `GET /venues/:slug` — returns venue config + bilingual menu. Cache in Redis.
   - `POST /orders` — creates order, reserves stock, calls the **venue's** Paymob to create a payment intention (card/Apple Pay), returns checkout URL. Cash orders skip Paymob.
   - `POST /webhooks/paymob` — verify HMAC (constant-time), set `payment_status PAID`, move to `CONFIRMED`, commit stock, call `routeOrder()`
   - `GET /orders/:id/status` — returns current order status
   - `POST /orders/:id/cancel` — customer cancel within the allowed window (5.9)

5. **Paymob integration**: Per-venue keys (encrypted). Payment intention + constant-time HMAC webhook verification. Card + Apple Pay in one checkout (do the Apple Pay domain verification). iframe with **hosted-page fallback for iOS Safari** (5.1).

6. **Payment methods**: Card, Apple Pay, and Cash (cash = offline, ticket flagged "collect at table", staff "mark collected").

7. **Order router**: The chain pattern in `src/connectors/router.ts` (5.4). For Phase 1, only the print tier needs to work, but build the chain/`ConnectorResult` shape now.

8. **Print agent (fallback only)**: `PosConnector`-conforming. WebSocket to backend, receives orders, prints via ESC/POS (table label + cash flag). Package as Node.js script. Test with a real thermal printer.

9. **PWA**: Bilingual menu browsing, cart, checkout (card/Apple Pay/cash), order confirmation polling, cancel-before-confirmed. Venue branding from API. NFC/QR param parsing from URL.

10. **Inventory**: Reserve-on-create, commit-on-confirm, release-on-expire/cancel (5.7), inside `SELECT FOR UPDATE` transactions. `available` auto-flip with buffer.

11. **Demo venue**: A hardcoded, publicly scannable demo (`taporder.io/order?venue=demo&table=t1`) with a sample bilingual menu and a test Paymob account — your single most powerful sales tool. This is Phase 1's final deliverable, not a real restaurant (Section 20).

**Phase 1 done when**: A customer scans an NFC tag (or the printed QR fallback) → sees the menu in Arabic → pays by card, Apple Pay, or chooses cash → kitchen printer produces a ticket showing the table label (and cash-collect flag if cash). All in under 60 seconds. The demo venue is live and shareable.

---

### Phase 2 — Foodics Connector (Week 4)

**Goal**: Full automation for Foodics restaurants. No print, no manual entry.

**What to build**:

1. **Foodics OAuth flow**: "Connect Foodics" button in venue admin → OAuth redirect → token storage (encrypted) → token refresh logic

2. **Foodics connector** (`src/connectors/foodics.ts`):
   - Product resolution (SKU mapping with 24h cache)
   - Order injection (`POST /api/v5/orders`)
   - Error handling with automatic fallback to print agent

3. **Venue admin panel**: Basic UI for venue staff — live order feed (SSE), mark items sold out, view today's orders, **cancel an order (triggers refund if paid)**, **mark cash order collected**.

4. **Menu image upload**: Admin UI to upload item images → backend issues an R2 presigned URL → direct multipart upload to Cloudflare R2 → store the URL in `menu_items.image_url`. (This is a non-trivial chunk of Phase 2, not a freebie — presigned flow, size/type validation, image resizing.)

5. **Platform admin dashboard**: All venues, order counts, Foodics connection status.

**Phase 2 done when**: A Foodics restaurant receives orders directly in their POS with zero human touch.

---

### Phase 3 — Agent Polish & Self-Healing (Week 5)

**Goal**: Agent is production-grade. You are never needed for day-to-day operations.

**What to build**:

1. **Agent health monitoring**: Backend tracks heartbeat. Marks agents OFFLINE after 90s silence. Dashboard shows status per venue.

2. **Schema health check**: Agent validates expected columns exist on startup and hourly. Reports `schema_ok: false` → backend alerts you, agent auto-falls-back to print.

3. **Agent auto-update (signed)**: Agent checks GitHub Releases on startup. **Verifies the binary's SHA-256 against a detached signature made with your release private key before executing**; rejects + alerts on mismatch. Applies on next scheduled restart. Downloads and restarts if a newer, validly-signed version is available.

4. **Alerting**: Sentry integration + Slack/email webhook for agent offline, order stuck, HMAC failures.

5. **Remote config push**: Backend can push updated POS schema configs to agents via WebSocket `CONFIG_UPDATE` message.

6. **Windows service packaging**: `node-windows` wrapper so agent survives reboots without manual start.

**Phase 3 done when**: You can go a week without touching anything and the system handles errors, reconnects, and fallbacks on its own.

---

### Phase 4 — DB Injector Connector (When Needed)

**Goal**: Full automation for Vortex and other legacy POS systems.

**What to build**:

1. **DB connector in agent**: `mssql` and `mysql2` driver support. Config-driven schema mapping. Parameterized queries only.

2. **SKU resolution**: Map your `pos_sku` to their internal product IDs on first run, cache locally.

3. **POS schema config file** for Vortex v3 (requires physical access to one installation to map — this is not code, it is fieldwork).

4. **Schema mismatch detection**: On each injection attempt, verify table/column existence before insert.

5. **Venue onboarding for DB tier**: Admin UI to enter DB connection details (encrypted before save).

**Phase 4 done when**: A Vortex restaurant receives orders injected directly into their POS database with zero manual entry, and falls back to print gracefully on any failure.

---

### Phase 5 — Scale Hardening (When Revenue Justifies)

1. Migrate from Supabase free tier to Hetzner managed PostgreSQL
2. Add second Hetzner VPS + Nginx load balancing
3. Redis Pub/Sub for WebSocket distribution across instances
4. Regression test suite (Vitest + Playwright)
5. Formal Foodics partner application
6. Full Arabic content pass + RTL polish (the i18n/RTL scaffolding already exists from Phase 1; this is translation completeness and design refinement, not retrofitting infrastructure)

---

## 17. Environment Variables

```env
# API
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
JWT_SECRET=
JWT_REFRESH_SECRET=
ENCRYPTION_KEY=          # AES-256 key for pos_credentials, db_config, paymob_config

# Paymob — per-venue keys live ENCRYPTED in venues.paymob_config, NOT here.
# The only global Paymob keys are for the demo venue (Section 20), if you choose to run one:
PAYMOB_DEMO_API_KEY=
PAYMOB_DEMO_HMAC_SECRET=
PAYMOB_DEMO_INTEGRATION_ID=
APPLE_PAY_DOMAIN=app.taporder.io   # for Apple Pay domain verification

# Foodics
FOODICS_CLIENT_ID=
FOODICS_CLIENT_SECRET=
FOODICS_REDIRECT_URI=

# Sentry
SENTRY_DSN=

# Alerts
SLACK_WEBHOOK_URL=

# Agent (in agent .env, per installation)
VENUE_ID=
AGENT_API_KEY=
BACKEND_WS_URL=wss://api.taporder.io/agent/connect
PRINTER_HOST=192.168.1.100
PRINTER_PORT=9100
POS_TYPE=PRINT_FALLBACK   # or DB_INJECTOR
AGENT_UPDATE_PUBLIC_KEY=  # public half of your release signing key — verifies update binaries
```

---

## 18. What the Developer Never Does

- Never store card data. Never.
- Never string-concatenate SQL. Parameterized queries only.
- Never commit `.env`. Ever.
- Never skip HMAC verification on Paymob webhooks.
- Never let a paid order silently disappear. Every failure gets logged, alerted, and falls back to print.
- Never add complexity without a real, present need. If Phase 1 works, don't pre-build Phase 4.

---

## 19. Instructions for Claude Code

1. Read this entire document before writing a single line of code.
2. Follow the folder structure in Section 5.2 exactly.
3. Follow the phased plan in Section 16 — do not skip ahead or merge phases.
4. Use the exact Prisma schema in Section 5.3 as the starting point.
5. The `CanonicalOrder` type in Section 5.4 is sacred — do not modify it without flagging why.
6. Every connector must implement the `PosConnector` interface. No exceptions.
7. Every order state transition must be logged with `pino` in structured JSON.
8. When in doubt about architecture, refer to Section 0. Simpler is correct.
9. Ask before adding any dependency not already implied by this spec.
10. Phase 1 must be fully working end-to-end before Phase 2 begins.

---

## 20. Venue Onboarding & Physical Deployment

The technical spec above describes the system; this section describes the **operational process** — what happens between "a restaurant says yes" and "the first real order goes through." It matters for your own sanity and is also a concrete thing to show prospects.

### 20.1 Onboarding runbook (restaurant signs up → first live order)

1. **Agreement & consent.** Sign the service agreement. It states: the platform fee model (flat SaaS fee and/or Split Payment commission); the inventory-divergence limitation for print-fallback venues (5.7); and, **if the DB-injector tier will be used, the venue's explicit written authorization to write to their POS database** (5.6).
2. **Create the venue.** Platform admin creates the venue record: name, slug, logo, primary color, `default_locale`, `stock_buffer`.
3. **Connect payments.** Enter the venue's own Paymob keys (stored encrypted in `paymob_config`). Confirm menu prices are tax-inclusive so charged total = POS total (5.8).
4. **Build the menu.** Enter items bilingually (name/name_ar, price tax-inclusive, category, stock). Upload images (R2 presigned flow, Phase 2). *Decide now who does this — you during onboarding, or the venue via the admin panel.*
5. **Choose POS tier & connect.** Foodics: OAuth "Connect Foodics." DB injector: field visit to map the schema + enter encrypted DB config. Otherwise: print fallback.
6. **Install the agent** (print or DB tiers): on the restaurant's PC (Windows service) or a Raspberry Pi. Enter agent `.env` (venue id, API key, printer host/port). Confirm heartbeat shows ONLINE on your dashboard.
7. **Program the table tags.** Write the tag URL per table (next section). Stick tags on tables.
8. **Test order.** Place a real end-to-end order on one table; confirm the ticket prints / POS receives it with the correct **table label**.
9. **Go live.** Hand over the staff admin login and a one-page "how to mark sold out / collect cash / cancel" guide.

### 20.2 NFC tag + QR fallback (one physical sticker, two ways in)

- Tag hardware: NTAG213. It encodes the URL `app.taporder.io/order?venue=<slug>&table=<nfc_slug>`. Keep `slug` and `nfc_slug` **short** — NTAG213 has ~132 usable bytes for the NDEF URI record, and a long slug plus a long table code can overflow it. `nfc_slug` is a short human-meaningless code (e.g. `t7`); the backend resolves it to the table's human-readable `label` ("Table 7"), which is what staff see on the ticket.
- **Print the same URL as a QR code on the same sticker.** NFC fails on older Androids, requires NFC enabled, and needs iOS 14+ for background tag reading; the QR is the universal fallback and costs nothing extra. Same URL, same destination.
- The customer never types a table number; scanning resolves it. The label travels with the order to the kitchen so the server delivers to the right table without the customer moving.

### 20.3 The demo venue (Phase 1 deliverable)

Run one always-on demo venue at a stable URL (`taporder.io/order?venue=demo&table=t1`) with a sample bilingual menu, sample branding, and a **test Paymob account** (the only place the global `PAYMOB_DEMO_*` keys are used). Anyone can scan, browse, and place a test order. This is your pitch in a link — far more persuasive than a slide deck, and it doubles as a smoke test that the whole pipeline is healthy.

---

## 21. Appendix A — Paymob API Contract (Normative)

> Added in support of Section 5.8. This is the **concrete, implement-exactly** contract for the Paymob integration — the part Claude Code cannot safely infer from memory. Sourced from Paymob's Egypt developer documentation. Where a host/path could differ for your specific account, it is flagged "verify in dashboard." Amounts are always **integer cents/piastres**, which matches the spec's money convention.

### 21.1 Credentials (per venue — stored encrypted in `venues.paymob_config`)

Each venue's Paymob account provides four values. Get them from the venue's Paymob Dashboard → Developers:
- **Secret Key** (`sk_...`) — used to authenticate the Intention Creation call. Header: `Authorization: Token <SECRET_KEY>`.
- **Public Key** (`pk_...`) — used to launch the Unified Checkout in the browser.
- **Integration ID(s)** — one per enabled payment method (e.g. an online-card integration ID). Card and Apple Pay are surfaced by the same checkout; you pass the card/online integration ID(s) in `payment_methods`.
- **HMAC Secret** — used to verify webhook authenticity (21.4).

Test vs Live: the Integration ID's mode (Test/Live) must match the mode of the Secret Key, or intention creation returns `404 Integration ID … does not exist`.

### 21.2 Create Intention (backend → Paymob)

```
POST https://accept.paymob.com/v1/intention/
Headers:
  Authorization: Token <VENUE_SECRET_KEY>
  Content-Type: application/json
```

Request body:
```json
{
  "amount": 15000,
  "currency": "EGP",
  "payment_methods": [<ONLINE_INTEGRATION_ID>],
  "items": [
    { "name": "Koshary (large)", "amount": 10000, "quantity": 1, "description": "..." },
    { "name": "Soft drink",      "amount": 5000,  "quantity": 1, "description": "..." }
  ],
  "billing_data": {
    "first_name": "Guest", "last_name": "Customer",
    "phone_number": "+20XXXXXXXXXX", "email": "guest@taporder.io",
    "country": "EGY", "city": "Cairo",
    "street": "NA", "building": "NA", "floor": "NA", "apartment": "NA"
  },
  "special_reference": "<your Order.id>",
  "extras": { "venue_id": "<uuid>", "table": "Table 7" },
  "notification_url": "https://api.taporder.io/webhooks/paymob",
  "redirection_url": "https://app.taporder.io/order/confirm?order=<your Order.id>",
  "expiration": 600
}
```

Hard requirements:
- `amount` is **cents/piastres** and must equal the sum of `items[].amount × quantity`. A mismatch is rejected.
- Every `items[]` object must include `name` and `amount` (both required, or 400).
- `billing_data.phone_number` is required (400 if missing). For guest checkout, use a placeholder or the optional `customer_phone` you collect.
- `special_reference` is **your** order id — it comes back in the callback as `merchant_order_id`, which is how you correlate the webhook to your `Order`.
- `notification_url` = your server webhook (21.4). `redirection_url` = where the customer's browser lands afterward.

Key response fields:
```json
{
  "id": "<paymob intention id>",
  "client_secret": "<csk_...>",
  "intention_order_id": <paymob order id>,
  "payment_keys": [ { "key": "<payment token>", "integration": <id> } ],
  "status": "intended"
}
```
Persist `intention_order_id` (Paymob's order id) and/or the intention `id` alongside your order so you can reconcile callbacks and issue refunds. Note: setting `payment_ref` here does **not** mean "paid" — payment is confirmed only by the verified webhook (see the idempotency rule in 5.8: key on `payment_status`, not on `payment_ref` presence).

### 21.3 Launch the checkout (browser)

Unified Checkout (recommended; handles card + Apple Pay + wallets on the same page):
```
https://accept.paymob.com/unifiedcheckout/?publicKey=<VENUE_PUBLIC_KEY>&clientSecret=<client_secret>
```
- Per 5.1: embed where it works, but **fall back to opening this as a full hosted page on iOS Safari** (and whenever the embed fails). Opening the hosted page in the same tab sidesteps the ITP/iframe issues.
- **Apple Pay** requires no separate code path — it appears automatically on Apple devices once (a) the venue's account has Apple Pay enabled and (b) `app.taporder.io` is registered for Apple Pay **domain verification** (the manual Apple step noted in Section 20). 
- *Verify in dashboard:* the exact checkout host can vary by account vintage (`accept.paymob.com` is current for Egypt). If your account uses the legacy iframe instead, the URL is `https://accept.paymob.com/api/acceptance/iframes/<IFRAME_ID>?payment_token=<payment_keys[].key>`.

### 21.4 Webhook verification (Paymob → backend) — the part most often done wrong

Paymob POSTs a transaction callback to your `notification_url` after a transaction succeeds or is declined. The body is `{ "type": "TRANSACTION", "obj": { ... } }` and a top-level `hmac` arrives **as a query parameter** on the callback URL. To verify:

1. Build the source string by concatenating the values of **exactly these fields, in exactly this order** (do not sort yourself — this is the canonical order Paymob uses):

```
amount_cents
created_at
currency
error_occured
has_parent_transaction
id
integration_id
is_3d_secure
is_auth
is_capture
is_refunded
is_standalone_payment
is_voided
order.id
owner
pending
source_data.pan
source_data.sub_type
source_data.type
success
```

2. HMAC-SHA512 that concatenated string with the venue's HMAC secret; hex-encode lowercase.
3. Constant-time compare against the received `hmac`. **Never** use `===`/`!==` on the hex strings (timing leak — see 5.8).

Booleans serialize as the lowercase strings `true`/`false`. The nested values are read from `obj`: `id` = `obj.id`, `order.id` = `obj.order.id`, `source_data.*` = `obj.source_data.*`.

```typescript
// NORMATIVE field order. Implementation is illustrative.
import crypto from 'crypto';

const HMAC_FIELDS = [
  'amount_cents','created_at','currency','error_occured','has_parent_transaction',
  'id','integration_id','is_3d_secure','is_auth','is_capture','is_refunded',
  'is_standalone_payment','is_voided','order.id','owner','pending',
  'source_data.pan','source_data.sub_type','source_data.type','success',
] as const;

function get(obj: any, path: string) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

function verifyPaymobHmac(obj: any, receivedHmac: string, venueHmacSecret: string): boolean {
  const concatenated = HMAC_FIELDS.map(f => String(get(obj, f))).join('');
  const expected = crypto.createHmac('sha512', venueHmacSecret)
                         .update(concatenated).digest('hex'); // lowercase hex
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(String(receivedHmac), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

On a verified callback: `obj.success === true` (and not `obj.is_voided` / `obj.is_refunded`) → set `payment_status: PAID`, `paid_at`, `payment_ref = obj.id`, move the order to `CONFIRMED`, commit stock, call `routeOrder()`. `obj.success === false` → payment failed; leave stock reserved until TTL `EXPIRED` (5.7). Apply the 5.8 idempotency rule before acting.

### 21.5 Refund & Void (for cancellation — Section 5.9)

These use the older Accept auth flow (an auth token derived from the account API key), separate from the Secret-Key auth used for intentions:

1. Get an auth token:
```
POST https://accept.paymob.com/api/auth/tokens
Body: { "api_key": "<VENUE_API_KEY>" }   → returns { "token": "..." }
```
2. **Void** (pre-settlement, same-day) → `payment_status: VOIDED`:
```
POST https://accept.paymob.com/api/acceptance/void_refund/void
Body: { "auth_token": "<token>", "transaction_id": <obj.id> }
```
3. **Refund** (post-settlement, full or partial) → `payment_status: REFUNDED`:
```
POST https://accept.paymob.com/api/acceptance/void_refund/refund
Body: { "auth_token": "<token>", "transaction_id": <obj.id>, "amount_cents": <amount> }
```
Store the returned reversal id in `orders.refund_ref`. A refunded/voided order restocks its items (5.7). Cash orders have no Paymob transaction, so cancellation of an unpaid cash order is just `CANCELLED` — no API call.

*Verify in dashboard:* confirm these `void_refund` paths and the auth-token host for your account; Paymob has more than one API generation live and a few accounts are provisioned on different hosts.

### 21.6 Quick reference

| Action | Method & URL | Auth |
|---|---|---|
| Create intention | `POST /v1/intention/` (accept.paymob.com) | `Token <secret_key>` |
| Launch checkout | `unifiedcheckout/?publicKey=…&clientSecret=…` | public key in URL |
| Webhook in | your `notification_url` | verify HMAC (21.4) |
| Auth token | `POST /api/auth/tokens` | `api_key` in body |
| Void | `POST /api/acceptance/void_refund/void` | `auth_token` in body |
| Refund | `POST /api/acceptance/void_refund/refund` | `auth_token` in body |

---
