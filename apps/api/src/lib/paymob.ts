import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Paymob integration — Section 5.8 + Appendix A (Section 21).
//
// All amounts are integer piastres (cents). Card and Apple Pay share ONE
// intention; the customer's method choice only changes which buttons Paymob
// renders inside the same checkout.
// ---------------------------------------------------------------------------

// Hosts per Appendix A (21.6). Egypt-current values; "verify in dashboard" per spec.
const PAYMOB_API_BASE = 'https://accept.paymob.com';
const UNIFIED_CHECKOUT_URL = `${PAYMOB_API_BASE}/unifiedcheckout/`;

export interface PaymobConfig {
  secretKey: string;     // sk_... — authenticates intention creation
  publicKey: string;     // pk_... — launches the browser checkout
  integrationId: number; // online/card integration id (Apple Pay surfaced on same)
  hmacSecret: string;    // verifies webhook authenticity (21.4)
}

// A minimal shape of the venue needed to resolve Paymob keys.
export interface VenueLike {
  id: string;
  paymob_config?: unknown; // encrypted JSON in the DB (decrypted in a later phase)
}

// Resolve the venue's Paymob credentials.
//
// TODO(per-venue keys): the spec (5.8 / 21.1) requires per-venue Paymob accounts
// with keys stored ENCRYPTED in venue.paymob_config (AES-256-GCM). For this
// session we read the single TEST account from env vars. When the encryption
// layer lands, decrypt venue.paymob_config here and fall back to env only for
// the demo venue. The signature already takes `venue` so callers need no change.
export function getPaymobConfig(_venue: VenueLike): PaymobConfig {
  const secretKey = process.env.PAYMOB_SECRET_KEY;
  const publicKey = process.env.PAYMOB_PUBLIC_KEY;
  const integrationIdRaw = process.env.PAYMOB_INTEGRATION_ID;
  const hmacSecret = process.env.PAYMOB_HMAC_SECRET;

  if (!secretKey || !publicKey || !integrationIdRaw || !hmacSecret) {
    throw new Error('paymob_not_configured');
  }

  const integrationId = Number(integrationIdRaw);
  if (!Number.isInteger(integrationId)) {
    throw new Error('paymob_bad_integration_id');
  }

  return { secretKey, publicKey, integrationId, hmacSecret };
}

export interface IntentionItem {
  name: string;
  amount: number;   // unit price, piastres
  quantity: number;
  description: string;
}

export interface CreateIntentionArgs {
  cfg: PaymobConfig;
  amount: number;            // total, piastres — must equal sum(items.amount * quantity)
  items: IntentionItem[];
  orderId: string;           // our Order.id → special_reference → merchant_order_id
  venueId: string;
  tableLabel: string;
  customerName?: string;
  customerPhone?: string;
  notificationUrl: string;   // WEBHOOK_BASE_URL + /webhooks/paymob
  redirectionUrl: string;    // FRONTEND_URL + /order/confirm?order=<id>
}

export interface IntentionResult {
  clientSecret: string;
  intentionId: string;
  intentionOrderId: number | null;
}

// Create a Paymob payment intention — Section 21.2.
export async function createIntention(args: CreateIntentionArgs): Promise<IntentionResult> {
  const {
    cfg, amount, items, orderId, venueId, tableLabel,
    customerName, customerPhone, notificationUrl, redirectionUrl,
  } = args;

  // Guest checkout: billing_data.phone_number is required (400 if missing).
  const phone = customerPhone && customerPhone.trim().length > 0 ? customerPhone : '+201000000000';
  const firstName = customerName && customerName.trim().length > 0 ? customerName : 'Guest';

  const body = {
    amount,
    currency: 'EGP',
    payment_methods: [cfg.integrationId],
    items: items.map((i) => ({
      name: i.name,
      amount: i.amount,
      quantity: i.quantity,
      description: i.description,
    })),
    billing_data: {
      first_name: firstName,
      last_name: 'Customer',
      phone_number: phone,
      email: 'guest@taporder.io',
      country: 'EGY',
      city: 'Cairo',
      street: 'NA',
      building: 'NA',
      floor: 'NA',
      apartment: 'NA',
    },
    special_reference: orderId,
    extras: { venue_id: venueId, table: tableLabel },
    notification_url: notificationUrl,
    redirection_url: redirectionUrl,
    expiration: 600,
  };

  const res = await fetch(`${PAYMOB_API_BASE}/v1/intention/`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${cfg.secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`paymob_intention_failed:${res.status}:${text.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    id?: string;
    client_secret?: string;
    intention_order_id?: number;
  };

  if (!data.client_secret) {
    throw new Error('paymob_intention_no_client_secret');
  }

  return {
    clientSecret: data.client_secret,
    intentionId: String(data.id ?? ''),
    intentionOrderId: data.intention_order_id ?? null,
  };
}

// Build the Unified Checkout URL — Section 21.3.
export function buildCheckoutUrl(publicKey: string, clientSecret: string): string {
  const params = new URLSearchParams({ publicKey, clientSecret });
  return `${UNIFIED_CHECKOUT_URL}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// HMAC verification — Section 21.4. THE HIGHEST-RISK PART.
//
// Field order is NORMATIVE: concatenate the values of EXACTLY these fields, in
// EXACTLY this order. Do not sort. Booleans serialize as lowercase 'true'/'false'.
// Note Paymob's known misspelling "error_occured" — it is intentional; do NOT
// "correct" it. Nested values read from obj: id = obj.id, order.id = obj.order.id,
// source_data.* = obj.source_data.*.
// ---------------------------------------------------------------------------
export const HMAC_FIELDS = [
  'amount_cents',
  'created_at',
  'currency',
  'error_occured',
  'has_parent_transaction',
  'id',
  'integration_id',
  'is_3d_secure',
  'is_auth',
  'is_capture',
  'is_refunded',
  'is_standalone_payment',
  'is_voided',
  'order.id',
  'owner',
  'pending',
  'source_data.pan',
  'source_data.sub_type',
  'source_data.type',
  'success',
] as const;

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => {
    if (o == null || typeof o !== 'object') return undefined;
    return (o as Record<string, unknown>)[k];
  }, obj);
}

// Build the concatenated HMAC source string in the canonical field order.
// Exported so the webhook handler can log it on a verification failure — when a
// real callback doesn't validate, this string reveals which field/casing is off.
export function buildHmacSourceString(obj: unknown): string {
  return HMAC_FIELDS.map((f) => String(getPath(obj, f))).join('');
}

export interface HmacResult {
  valid: boolean;
  source: string; // the concatenated source string (for debug logging on failure)
}

// Verify a Paymob webhook HMAC with constant-time comparison.
export function verifyPaymobHmac(obj: unknown, receivedHmac: string, hmacSecret: string): HmacResult {
  const source = buildHmacSourceString(obj);
  const expected = crypto.createHmac('sha512', hmacSecret).update(source).digest('hex'); // lowercase hex

  let valid = false;
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(String(receivedHmac ?? ''), 'hex');
    // NEVER use === on the hex strings (timing leak). Lengths must match for timingSafeEqual.
    valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    valid = false;
  }

  return { valid, source };
}
