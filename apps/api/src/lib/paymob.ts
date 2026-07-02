import crypto from 'node:crypto';
import { config } from './config.js';

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
  apiKey?: string;       // account api_key — authenticates the void/refund flow (21.5).
                         // OPTIONAL: intention + webhook paths don't need it; only the
                         // reversal client does. Distinct from secretKey (see 21.1 vs 21.5).
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

  // apiKey is intentionally NOT part of the required set above — the intention and
  // webhook flows must keep working even if the reversal credential is absent. The
  // reversal client validates its presence itself and fails loudly if it's needed.
  const apiKey = process.env.PAYMOB_API_KEY || undefined;

  return { secretKey, publicKey, integrationId, hmacSecret, apiKey };
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
  notificationUrl: string;   // API_BASE_URL + /webhooks/paymob
  redirectionUrl: string;    // APP_BASE_URL + /order/confirm/<id>
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
      email: config.guestEmail,
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

// ---------------------------------------------------------------------------
// Reversal (Void / Refund) — Section 5.9 + Appendix A (21.5). MONEY-CRITICAL.
//
// This flow uses the OLDER Accept auth: POST /api/auth/tokens with the account
// `api_key` → auth token, then void/refund with that token. This is a DIFFERENT
// credential and endpoint family from the Secret-Key auth used for intentions.
//
// Selection is AUTOMATIC (staff never choose): attempt VOID first (pre-settlement,
// cheaper); if Paymob signals the transaction is already settled, fall back to
// REFUND. Full amount only — no partial refunds this session.
// ---------------------------------------------------------------------------

// Minimal structured logger shape (Fastify's `log` satisfies this; the router
// passes a console-JSON shim). Kept local so lib/ has no logging dependency.
export interface PaymobLogger {
  info(o: object, msg?: string): void;
  warn(o: object, msg?: string): void;
  error(o: object, msg?: string): void;
}

export type ReversalMode = 'void' | 'refund';

// Thrown only when BOTH void and refund fail. Carries the raw responses so the
// caller can log them and a human can reconcile. Never thrown on partial success.
export class PaymobReversalError extends Error {
  constructor(message: string, readonly detail: unknown) {
    super(message);
    this.name = 'PaymobReversalError';
  }
}

interface RawResponse {
  status: number;
  ok: boolean;
  body: Record<string, unknown>;
}

// Paymob's void/refund require the transaction id AS AN INTEGER ("Transaction ID is
// always an integer"). Our payment_ref stores Paymob's obj.id, normally numeric —
// send it as a Number so a numeric string isn't rejected as "invalid format". A
// non-numeric id (shouldn't happen for a real Paymob txn) is passed through as-is.
function coerceTxnId(id: string): number | string {
  return /^\d+$/.test(id) ? Number(id) : id;
}

async function postJson(url: string, payload: object): Promise<RawResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, ok: res.ok, body };
}

// Step 1 of 21.5: exchange the account api_key for a short-lived auth token.
async function getReversalAuthToken(apiKey: string): Promise<string> {
  const res = await postJson(`${PAYMOB_API_BASE}/api/auth/tokens`, { api_key: apiKey });
  const token = res.body?.token;
  if (!res.ok || typeof token !== 'string' || token.length === 0) {
    throw new PaymobReversalError('paymob_auth_failed', { step: 'auth', ...res });
  }
  return token;
}

// The reversal response is a new transaction object; its `id` is what we persist
// as refund_ref. Shapes vary slightly by account generation, so probe a few keys.
function extractReversalId(body: Record<string, unknown>): string | null {
  const candidates = [body.id, (body.data as Record<string, unknown> | undefined)?.id, body.transaction_id];
  for (const c of candidates) {
    if (c != null && (typeof c === 'string' || typeof c === 'number')) return String(c);
  }
  return null;
}

// Did a VOID succeed outright?  Confirmed against a real TEST response (2026-07-02):
// HTTP 201, body.success === true, body.is_void === true, txn_response_code APPROVED.
function voidSucceeded(res: RawResponse): boolean {
  const b = res.body ?? {};
  return res.ok && (b.success === true || b.success === 'true' || b.is_void === true);
}

// Does a failed VOID response indicate the transaction is ALREADY SETTLED (so we
// must refund instead)?  >>> VERIFY AGAINST REAL RESPONSES with the probe script
// (scripts/paymob-reversal-probe.mjs) — Paymob's exact shape differs per account.
// Heuristic: any settlement / not-voidable / "refund instead" signal in the body.
// Detection is based on the RESPONSE, never on elapsed time (per session brief).
function voidIndicatesSettled(res: RawResponse): boolean {
  const blob = JSON.stringify(res.body ?? {}).toLowerCase();
  return (
    blob.includes('settle') ||        // "already settled", "transaction is settled"
    blob.includes('not voidable') ||
    blob.includes('cannot be voided') ||
    blob.includes('use refund') ||
    blob.includes('already refunded')
  );
}

// Mirror of voidSucceeded for the refund response (refund uses is_refund, like void's
// is_void). NOTE: the refund BRANCH is unverified on the current test account — it is
// "Pending Onboarding" with eligible_for_manual_refunds=false and never settles, so no
// settled transaction could be produced to exercise it. Control flow is still correct:
// refund is only attempted when void did not succeed, and a rejected refund throws
// (payment_status stays PAID) rather than being mistaken for success.
function refundSucceeded(res: RawResponse): boolean {
  const b = res.body ?? {};
  return res.ok && (b.success === true || b.success === 'true' || b.is_refund === true);
}

export interface ReversePaymobArgs {
  apiKey?: string;
  transactionId: string;   // Paymob transaction id = our Order.payment_ref
  amountCents: number;     // full order total, piastres (refund needs an amount)
  orderId: string;         // for logging/correlation
  venueId: string;
  log: PaymobLogger;
}

export interface ReversePaymobResult {
  mode: ReversalMode;
  reversalId: string;
}

// Orchestrate auth → void → (if settled) refund. On success, the reversal id is
// LOGGED IMMEDIATELY (before the caller writes the DB) so a successful Paymob call
// is never unrecoverable if the follow-up DB write fails. Throws PaymobReversalError
// only when BOTH void and refund fail — the caller then leaves the order flagged.
export async function reversePaymobTransaction(args: ReversePaymobArgs): Promise<ReversePaymobResult> {
  const { apiKey, transactionId, amountCents, orderId, venueId, log } = args;
  if (!apiKey) {
    throw new PaymobReversalError('paymob_reversal_not_configured', { reason: 'missing_api_key' });
  }

  const token = await getReversalAuthToken(apiKey);

  const txn = coerceTxnId(transactionId);

  // --- Attempt VOID first ---
  const voidRes = await postJson(`${PAYMOB_API_BASE}/api/acceptance/void_refund/void`, {
    auth_token: token,
    transaction_id: txn,
  });

  if (voidSucceeded(voidRes)) {
    const reversalId = extractReversalId(voidRes.body) ?? transactionId;
    // Log the id the instant Paymob confirms — before any DB write.
    log.info({ event: 'paymob_reversal_ok', order_id: orderId, venue_id: venueId, mode: 'void', reversal_id: reversalId });
    return { mode: 'void', reversalId };
  }

  log.warn({
    event: 'paymob_void_not_applied',
    order_id: orderId,
    settled_signal: voidIndicatesSettled(voidRes),
    void_status: voidRes.status,
  });

  // --- Void didn't apply (settled, or otherwise). Fall back to REFUND. ---
  const refundRes = await postJson(`${PAYMOB_API_BASE}/api/acceptance/void_refund/refund`, {
    auth_token: token,
    transaction_id: txn,
    amount_cents: amountCents,
  });

  if (refundSucceeded(refundRes)) {
    const reversalId = extractReversalId(refundRes.body) ?? transactionId;
    log.info({ event: 'paymob_reversal_ok', order_id: orderId, venue_id: venueId, mode: 'refund', reversal_id: reversalId });
    return { mode: 'refund', reversalId };
  }

  // --- Both failed: do NOT flip payment_status. Surface for manual retry. ---
  log.error({
    event: 'paymob_reversal_failed',
    order_id: orderId,
    venue_id: venueId,
    void_status: voidRes.status,
    refund_status: refundRes.status,
  });
  throw new PaymobReversalError('paymob_reversal_failed', {
    void: voidRes,
    refund: refundRes,
  });
}
