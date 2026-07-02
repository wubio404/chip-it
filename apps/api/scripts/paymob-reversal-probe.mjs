#!/usr/bin/env node
// Paymob void/refund PROBE — Section 21.5.
//
// Purpose: capture the REAL response shape of a VOID against (a) a fresh/unsettled
// transaction and (b) an already-settled transaction, so the settlement-detection
// branch in src/lib/paymob.ts (voidIndicatesSettled) can be confirmed/adjusted
// against reality instead of a guess. It does NOT touch the database.
//
// Usage (from apps/api/):
//   node scripts/paymob-reversal-probe.mjs <transaction_id>                 # void only
//   node scripts/paymob-reversal-probe.mjs <transaction_id> --refund <amt>  # void, then refund <amt> piastres
//
// PAYMOB_API_KEY is read from the environment, or parsed from apps/api/.env.
// Run it TWICE:
//   1) against a fresh transaction  → expect void success
//   2) against a settled transaction → capture the "cannot void / settled" shape
// Then paste BOTH raw outputs back so the branch logic can be finalized.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PAYMOB_API_BASE = 'https://accept.paymob.com';

function loadApiKey() {
  if (process.env.PAYMOB_API_KEY) return process.env.PAYMOB_API_KEY;
  try {
    const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
    const line = readFileSync(envPath, 'utf8').split(/\r?\n/).find((l) => l.startsWith('PAYMOB_API_KEY='));
    if (line) return line.slice('PAYMOB_API_KEY='.length).trim().replace(/^["']|["']$/g, '');
  } catch { /* ignore */ }
  return '';
}

async function post(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let body;
  const text = await res.text();
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, ok: res.ok, body };
}

function dump(label, r) {
  console.log(`\n===== ${label} =====`);
  console.log(`HTTP ${r.status} (ok=${r.ok})`);
  console.log(typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 2));
}

const [, , transactionId, ...rest] = process.argv;
if (!transactionId) {
  console.error('Usage: node scripts/paymob-reversal-probe.mjs <transaction_id> [--refund <amount_cents>]');
  process.exit(1);
}
const refundIdx = rest.indexOf('--refund');
const refundAmount = refundIdx >= 0 ? Number(rest[refundIdx + 1]) : null;

// Paymob's transaction id is ALWAYS an integer (Paymob's own txn id = Order.payment_ref,
// NOT your Order.id UUID). Guard against the easy mistake of passing a UUID.
if (!/^\d+$/.test(transactionId)) {
  console.error(`\n>>> "${transactionId}" is not an integer.`);
  console.error('    Paymob void/refund need Paymob\'s NUMERIC transaction id, not your Order UUID.');
  console.error('    Find it in Paymob Dashboard → Transactions, or in your DB as Order.payment_ref.\n');
  process.exit(1);
}
const txn = Number(transactionId);

const apiKey = loadApiKey();
if (!apiKey) {
  console.error('PAYMOB_API_KEY not set (env or apps/api/.env). Aborting.');
  process.exit(1);
}

const auth = await post(`${PAYMOB_API_BASE}/api/auth/tokens`, { api_key: apiKey });
const token = auth.body?.token;
// Don't dump the whole profile — just confirm auth + surface refund-eligibility flags.
console.log(`\n===== AUTH =====\nHTTP ${auth.status} — token ${token ? 'acquired' : 'MISSING'}`);
if (auth.body?.profile) {
  const p = auth.body.profile;
  console.log(`merchant_status="${p.dashboard_merchant_status}" eligible_for_manual_refunds=${p.eligible_for_manual_refunds} can_process_multiple_refunds=${p.can_process_multiple_refunds}`);
}
if (!token) { console.error('\nNo auth token returned — cannot continue.'); process.exit(1); }

const voidRes = await post(`${PAYMOB_API_BASE}/api/acceptance/void_refund/void`, {
  auth_token: token,
  transaction_id: txn,
});
dump('VOID /api/acceptance/void_refund/void', voidRes);

if (refundAmount != null && Number.isFinite(refundAmount)) {
  const refundRes = await post(`${PAYMOB_API_BASE}/api/acceptance/void_refund/refund`, {
    auth_token: token,
    transaction_id: txn,
    amount_cents: refundAmount,
  });
  dump('REFUND /api/acceptance/void_refund/refund', refundRes);
}

console.log('\nDone. Paste the VOID block above for BOTH a fresh and a settled transaction.');
