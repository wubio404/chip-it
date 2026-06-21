// Server-side (SSR) calls use the direct API URL — server-to-server, no CORS.
// Client-side calls use /api-proxy/* — same-origin, Next.js rewrites to the API.
const SERVER_API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';
const CLIENT_PROXY = '/api-proxy';

export interface MenuItem {
  id: string;
  sku: string;
  name: string;
  name_ar: string | null;
  description: string | null;
  description_ar: string | null;
  price: number; // integer piastres — tax-inclusive
  category: string;
  category_ar: string | null;
  available: boolean;
  image_url: string | null;
}

export interface VenueTable {
  id: string;
  label: string;
  nfc_slug: string;
}

export interface VenueResponse {
  id: string;
  slug: string;
  name: string;
  logo_url: string | null;
  primary_color: string;
  default_locale: string;
  tables: VenueTable[];
  menu_items: MenuItem[];
}

export interface CreateOrderBody {
  venue_slug: string;
  table_nfc_slug: string;
  customer_name?: string;
  payment_method: 'CASH' | 'CARD' | 'APPLE_PAY';
  items: Array<{ sku: string; qty: number }>;
}

// Cash response: { id, status, payment_status, routing_tier, table_label, total }
// Card response: { order_id, checkout_url }
export interface CreateOrderResponse {
  id?: string;
  order_id?: string;
  status?: string;
  payment_status?: string;
  routing_tier?: string | null;
  table_label?: string;
  total?: number;
  checkout_url?: string;
}

export interface OrderStatus {
  id: string;
  status: string;
  payment_status: string;
  routing_tier: string | null;
  table_label: string;
  total: number; // integer piastres — display only, never send back to API
}

/** Called from a server component — uses direct API URL (no CORS). */
export async function fetchVenue(slug: string): Promise<VenueResponse> {
  const res = await fetch(`${SERVER_API}/venues/${encodeURIComponent(slug)}`, {
    cache: 'no-store',
  });
  if (res.status === 404) throw Object.assign(new Error('venue_not_found'), { status: 404 });
  if (!res.ok) throw new Error(`venue_fetch_failed:${res.status}`);
  return res.json() as Promise<VenueResponse>;
}

/** Called from client components — goes through /api-proxy (same origin, no CORS). */
export async function createOrder(body: CreateOrderBody): Promise<CreateOrderResponse> {
  const res = await fetch(`${CLIENT_PROXY}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw Object.assign(new Error(data.error ?? 'order_failed'), { status: res.status, data });
  }
  return res.json() as Promise<CreateOrderResponse>;
}

/** Called from client components — goes through /api-proxy. */
export async function getOrderStatus(id: string): Promise<OrderStatus> {
  const res = await fetch(`${CLIENT_PROXY}/orders/${encodeURIComponent(id)}/status`);
  if (!res.ok) throw new Error('status_fetch_failed');
  return res.json() as Promise<OrderStatus>;
}

/** Called from client components — goes through /api-proxy. */
export async function cancelOrder(id: string): Promise<void> {
  const res = await fetch(`${CLIENT_PROXY}/orders/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw Object.assign(new Error(data.error ?? 'cancel_failed'), { status: res.status });
  }
}
