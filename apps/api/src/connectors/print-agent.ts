import type { PosConnector, ConnectorResult, CanonicalOrder, VenueConfig } from '@taporder/types';
import { agentManager } from '../agents/manager.js';

// Sends the order to the on-premise agent via WebSocket.
// Returns ok: false with error 'no_agent_connected' when no agent is online for this venue —
// the router handles that case specially (status stays CONFIRMED, routing_tier = 'offline').
export const printAgentConnector: PosConnector = {
  name: 'print_agent',

  async inject(order: CanonicalOrder, venue: VenueConfig): Promise<ConnectorResult> {
    const sent = agentManager.send(venue.id, { type: 'ORDER', payload: order });

    if (!sent) {
      return { ok: false, tier: 'print', error: 'no_agent_connected' };
    }

    // The agent receives the order and prints asynchronously; it will send ORDER_RESULT back.
    // We report ok: true once the message is delivered to the open socket.
    return { ok: true, tier: 'print' };
  },
};
