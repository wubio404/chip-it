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
  stock_count: number | null;
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
}

// ---------------------------------------------------------------------------
// Shared client fetch wrapper — used by both the guest PWA flow and the venue
// staff admin panel, so there is exactly one place that knows about the
// same-origin proxy, credentials, and the 401 -> refresh-once -> retry dance.
//
// Guest endpoints (create/cancel order, order status) never return 401, so the
// refresh branch is simply never taken for them — safe to share.
// ---------------------------------------------------------------------------

class ApiError extends Error {
  status: number;
  data?: unknown;
  constructor(message: string, status: number, data?: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  const data = await res.json().catch(() => ({})) as { error?: string };
  return new ApiError(data.error ?? 'request_failed', res.status, data);
}

function redirectToLogin(): void {
  if (typeof window === 'undefined') return;
  const match = window.location.pathname.match(/^\/admin\/([^/]+)/);
  window.location.href = match ? `/admin/${match[1]}/login` : '/admin';
}

async function tryRefresh(): Promise<boolean> {
  try {
    const res = await fetch(`${CLIENT_PROXY}/auth/refresh`, { method: 'POST', credentials: 'include' });
    return res.ok;
  } catch {
    return false;
  }
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const doFetch = () =>
    fetch(`${CLIENT_PROXY}${path}`, {
      ...init,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });

  let res = await doFetch();

  if (res.status === 401) {
    const refreshed = await tryRefresh();
    if (!refreshed) {
      redirectToLogin();
      throw new ApiError('unauthorized', 401);
    }
    res = await doFetch();
    if (res.status === 401) {
      redirectToLogin();
      throw new ApiError('unauthorized', 401);
    }
  }

  if (!res.ok) throw await toApiError(res);

  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
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

/** Called from client components (admin panel menu management) — goes through /api-proxy. */
export async function fetchVenueClient(slug: string): Promise<VenueResponse> {
  const res = await fetch(`${CLIENT_PROXY}/venues/${encodeURIComponent(slug)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`venue_fetch_failed:${res.status}`);
  return res.json() as Promise<VenueResponse>;
}

/** Called from client components — goes through /api-proxy (same origin, no CORS). */
export async function createOrder(body: CreateOrderBody): Promise<CreateOrderResponse> {
  return apiFetch<CreateOrderResponse>('/orders', { method: 'POST', body: JSON.stringify(body) });
}

/** Called from client components — goes through /api-proxy. */
export async function getOrderStatus(id: string): Promise<OrderStatus> {
  return apiFetch<OrderStatus>(`/orders/${encodeURIComponent(id)}/status`);
}

/** Called from client components — goes through /api-proxy. */
export async function cancelOrder(id: string): Promise<void> {
  await apiFetch<void>(`/orders/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: JSON.stringify({}) });
}

// ---------------------------------------------------------------------------
// Venue staff admin panel (Phase 2 item 3)
// ---------------------------------------------------------------------------

export interface AdminUser {
  id: string;
  role: 'PLATFORM_ADMIN' | 'VENUE_STAFF';
  venue_id: string | null;
}

export interface AdminVenue {
  id: string;
  slug: string;
  name: string;
  default_locale: string;
}

export interface AdminMeResponse {
  user: AdminUser;
  venue: AdminVenue;
}

export type AdminMeResult =
  | { ok: true; me: AdminMeResponse }
  // status 403 + ownVenueSlug means: authenticated, just at the wrong venue's URL
  // (a VENUE_STAFF hitting another venue's slug) — the caller can send them to
  // their own panel instead of a login page for a venue they can't access.
  | { ok: false; status: number; ownVenueSlug?: string };

/**
 * Server-component-only: calls /admin/me with the incoming request's cookies
 * forwarded manually (server components don't share the browser's cookie jar).
 */
export async function fetchAdminMeServer(venueSlug: string, cookieHeader: string): Promise<AdminMeResult> {
  const res = await fetch(`${SERVER_API}/admin/me?venue=${encodeURIComponent(venueSlug)}`, {
    headers: { Cookie: cookieHeader },
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { own_venue_slug?: string };
    return { ok: false, status: res.status, ownVenueSlug: body.own_venue_slug };
  }
  return { ok: true, me: (await res.json()) as AdminMeResponse };
}

/** Raw fetch (not apiFetch) — a 401 here is "wrong password", not "session expired". */
export async function adminLogin(email: string, password: string): Promise<void> {
  const res = await fetch(`${CLIENT_PROXY}/auth/login`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw await toApiError(res);
}

/** Raw fetch — logging out should never trigger a refresh-and-retry loop. */
export async function adminLogout(): Promise<void> {
  await fetch(`${CLIENT_PROXY}/auth/logout`, { method: 'POST', credentials: 'include' });
}

export interface AdminOrderItem {
  sku: string;
  pos_sku?: string;
  name: string;
  qty: number;
  unit_price: number; // integer piastres
}

export interface AdminOrder {
  id: string;
  venue_id: string;
  table_label: string;
  customer_name: string | null;
  items: AdminOrderItem[];
  total: number; // integer piastres
  status: string;
  payment_method: 'CARD' | 'APPLE_PAY' | 'CASH';
  payment_status: 'UNPAID' | 'PAID' | 'REFUNDED' | 'VOIDED';
  payment_ref: string | null;
  created_at: string;
  updated_at: string;
  paid_at: string | null;
}

export async function fetchTodaysOrders(venueId: string): Promise<AdminOrder[]> {
  return apiFetch<AdminOrder[]>(`/admin/venues/${encodeURIComponent(venueId)}/orders`);
}

export function adminOrderStreamUrl(venueId: string): string {
  return `${CLIENT_PROXY}/admin/venues/${encodeURIComponent(venueId)}/orders/stream`;
}

export async function toggleItemAvailability(
  venueId: string,
  sku: string,
  available: boolean,
): Promise<{ sku: string; available: boolean }> {
  return apiFetch(`/admin/venues/${encodeURIComponent(venueId)}/items/${encodeURIComponent(sku)}/toggle`, {
    method: 'POST',
    body: JSON.stringify({ available }),
  });
}

export async function cancelOrderAdmin(
  venueId: string,
  orderId: string,
): Promise<{ ok: true; status: string; payment_status: string }> {
  return apiFetch(`/admin/venues/${encodeURIComponent(venueId)}/orders/${encodeURIComponent(orderId)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

// ---------------------------------------------------------------------------
// Menu item image upload (Section 12 / Phase 2 item 4)
// ---------------------------------------------------------------------------

export interface ImagePresignResult {
  upload_url: string;
  key: string;
  public_url: string;
}

export async function presignItemImage(
  venueId: string,
  sku: string,
  contentType: string,
  contentLength: number,
): Promise<ImagePresignResult> {
  return apiFetch(`/admin/venues/${encodeURIComponent(venueId)}/items/${encodeURIComponent(sku)}/image/presign`, {
    method: 'POST',
    body: JSON.stringify({ content_type: contentType, content_length: contentLength }),
  });
}

export async function confirmItemImage(
  venueId: string,
  sku: string,
  key: string,
): Promise<{ sku: string; image_url: string }> {
  return apiFetch(`/admin/venues/${encodeURIComponent(venueId)}/items/${encodeURIComponent(sku)}/image/confirm`, {
    method: 'POST',
    body: JSON.stringify({ key }),
  });
}

export async function collectOrderAdmin(
  venueId: string,
  orderId: string,
): Promise<{ ok: true; payment_status: string }> {
  // apiFetch always sends Content-Type: application/json — Fastify rejects that
  // combined with a truly empty body (FST_ERR_CTP_EMPTY_JSON_BODY), so an explicit
  // '{}' is required even though the endpoint doesn't read anything from it.
  return apiFetch(`/admin/venues/${encodeURIComponent(venueId)}/orders/${encodeURIComponent(orderId)}/collect`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}
