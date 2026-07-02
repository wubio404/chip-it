import type { CanonicalOrder, ConnectorResult, PosConnector } from '@taporder/types';
import { prisma } from '../lib/db.js';
import { printAgentConnector } from './print-agent.js';
import { reverseOrderPayment, PaymobReversalError } from '../services/refunds.js';

function buildChain(posType: string): PosConnector[] {
  switch (posType) {
    case 'FOODICS':      return [printAgentConnector]; // foodics connector added in Phase 2
    case 'DB_INJECTOR':  return [printAgentConnector]; // db injector added in Phase 4
    case 'PRINT_FALLBACK':
    default:             return [printAgentConnector];
  }
}

// Routes a confirmed order through the connector chain. Owns all fallback logic and all
// status transitions after CONFIRMED. Connectors are pure — they never know about each other.
//
// Special case for print_agent: if no agent is connected, the order stays CONFIRMED with
// routing_tier = 'offline' rather than transitioning to FAILED. A paid order is never silently lost.
export async function routeOrder(order: CanonicalOrder, venueId: string, posType: string): Promise<void> {
  await prisma.order.update({
    where: { id: order.id },
    data: { status: 'ROUTING' },
  });

  console.log(JSON.stringify({ level: 'info', event: 'order_routing_start', order_id: order.id, venue_id: venueId }));

  const chain = buildChain(posType);

  // TEST-ONLY: force a full connector-chain failure to exercise the FAILED →
  // auto-refund path (5.4 / 5.9). Set FORCE_ROUTING_FAILURE=1 in the API .env and
  // restart; every connector reports a hard failure (NOT 'no_agent_connected', so
  // the order proceeds to FAILED instead of the offline hold). Unset/remove the var
  // and restart to return to normal routing.
  const forceFailure = process.env.FORCE_ROUTING_FAILURE === '1' || process.env.FORCE_ROUTING_FAILURE === 'true';
  if (forceFailure) {
    console.error(JSON.stringify({ level: 'warn', event: 'routing_force_failure_enabled', order_id: order.id, venue_id: venueId }));
  }

  for (const connector of chain) {
    const result: ConnectorResult = forceFailure
      ? { ok: false, tier: 'print', error: 'forced_failure' }
      : await connector.inject(order, {
          id: venueId,
          slug: '',
          pos_type: posType as 'FOODICS' | 'DB_INJECTOR' | 'PRINT_FALLBACK',
        });

    if (result.ok) {
      const nextStatus = result.tier === 'print' ? 'PRINTED' : 'INJECTED';
      await prisma.order.update({
        where: { id: order.id },
        data: { status: nextStatus, routing_tier: result.tier, pos_ref: result.pos_ref ?? null },
      });
      console.log(JSON.stringify({ level: 'info', event: 'order_routed', order_id: order.id, tier: result.tier, status: nextStatus }));
      return;
    }

    // No agent connected — order stays CONFIRMED (not FAILED); will be retried when agent reconnects.
    if (result.error === 'no_agent_connected') {
      await prisma.order.update({
        where: { id: order.id },
        data: { status: 'CONFIRMED', routing_tier: 'offline' },
      });
      console.error(JSON.stringify({ level: 'warn', event: 'order_routing_offline', order_id: order.id, venue_id: venueId }));
      return;
    }

    console.error(JSON.stringify({ level: 'warn', event: 'connector_failed', connector: connector.name, order_id: order.id, error: result.error }));
  }

  // Every connector in the chain failed for a real reason (not just offline).
  await prisma.order.update({
    where: { id: order.id },
    data: { status: 'FAILED', routing_tier: null },
  });
  // Alert immediately (5.4 / 15). Sentry/Slack wiring is a later phase; this is the hook.
  console.error(JSON.stringify({ level: 'error', event: 'all_connectors_failed', order_id: order.id, venue_id: venueId }));

  // FAILED → auto-refund (5.9). A paid ONLINE order that could not be routed must not
  // leave the customer charged for food they won't get. Same reversal client as the
  // human triggers — invoked here by the router instead. Cash has nothing to reverse.
  if (order.payment_status === 'PAID' && order.payment_method !== 'CASH') {
    try {
      const outcome = await reverseOrderPayment(order.id, { trigger: 'failed_routing' });
      if (outcome.ok) {
        console.log(JSON.stringify({ level: 'info', event: 'failed_order_auto_reversed', order_id: order.id, venue_id: venueId, mode: outcome.mode, reversal_id: outcome.reversalId }));
      } else {
        console.error(JSON.stringify({ level: 'error', event: 'failed_order_auto_reverse_skipped', order_id: order.id, reason: outcome.reason }));
      }
    } catch (err) {
      const msg = err instanceof PaymobReversalError ? err.message : String(err);
      // Reversal itself failed — order stays FAILED + PAID, flagged for the sweep/manual retry.
      console.error(JSON.stringify({ level: 'error', event: 'failed_order_auto_reverse_failed', order_id: order.id, venue_id: venueId, error: msg }));
    }
  }
}
