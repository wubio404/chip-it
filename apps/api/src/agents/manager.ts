import type { WebSocket } from 'ws';

// In-memory map of venue_id → active WebSocket connection.
// A venue can have at most one connected agent at a time.
const connections = new Map<string, WebSocket>();

export const agentManager = {
  register(venueId: string, ws: WebSocket): void {
    connections.set(venueId, ws);
  },

  unregister(venueId: string): void {
    connections.delete(venueId);
  },

  get(venueId: string): WebSocket | undefined {
    return connections.get(venueId);
  },

  // Send a JSON message to the agent for the given venue.
  // Returns true if the connection exists and is open, false otherwise.
  send(venueId: string, message: object): boolean {
    const ws = connections.get(venueId);
    if (!ws || ws.readyState !== ws.OPEN) return false;
    ws.send(JSON.stringify(message));
    return true;
  },
};
