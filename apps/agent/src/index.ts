import 'dotenv/config';
import WebSocket from 'ws';
import type { CanonicalOrder } from '@taporder/types';

const BACKEND_WS_URL = process.env.BACKEND_WS_URL ?? 'ws://localhost:3001/agent/connect';
const VENUE_ID = process.env.VENUE_ID;
const AGENT_API_KEY = process.env.AGENT_API_KEY;

if (!VENUE_ID || !AGENT_API_KEY) {
  console.error('Missing required env vars: VENUE_ID, AGENT_API_KEY');
  process.exit(1);
}

let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30_000;

function connect(): void {
  const ws = new WebSocket(BACKEND_WS_URL, {
    headers: { Authorization: `Bearer ${AGENT_API_KEY}` },
  });

  const heartbeatTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'HEARTBEAT', venue_id: VENUE_ID, schema_ok: true, printer_ok: true }));
    }
  }, 30_000);

  ws.on('open', () => {
    reconnectDelay = 1000;
    console.log(JSON.stringify({ event: 'agent_connected', venue_id: VENUE_ID, url: BACKEND_WS_URL }));
  });

  ws.on('message', (raw: Buffer) => {
    let msg: { type: string; payload?: unknown };
    try {
      msg = JSON.parse(raw.toString()) as { type: string; payload?: unknown };
    } catch {
      return;
    }

    if (msg.type === 'ORDER') {
      const order = msg.payload as CanonicalOrder;
      printTicket(order);
      ws.send(JSON.stringify({ type: 'ORDER_RESULT', order_id: order.id, status: 'printed', tier: 'print' }));
    }
  });

  ws.on('error', (err: Error) => {
    console.error(JSON.stringify({ event: 'ws_error', error: err.message }));
  });

  ws.on('close', (code: number, reason: Buffer) => {
    clearInterval(heartbeatTimer);
    console.log(JSON.stringify({ event: 'agent_disconnected', code, reason: reason.toString() }));
    scheduleReconnect();
  });
}

function scheduleReconnect(): void {
  console.log(JSON.stringify({ event: 'reconnect_scheduled', delay_ms: reconnectDelay }));
  setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    connect();
  }, reconnectDelay);
}

// Formats integer piastres as "EGP X.YY" (e.g. 5000 → "EGP 50.00")
function formatPrice(piastres: number): string {
  const pounds = Math.floor(piastres / 100);
  const cents = piastres % 100;
  return `EGP ${pounds}.${String(cents).padStart(2, '0')}`;
}

// Renders the full ticket to stdout. The same content would go to a thermal printer
// when hardware is configured (PRINTER_HOST / PRINTER_PORT env vars, Phase 3).
function printTicket(order: CanonicalOrder): void {
  const LINE = '─'.repeat(40);
  const shortId = order.id.slice(-6).toUpperCase();

  const lines: string[] = [
    '',
    LINE,
    `         ${order.table}`,
    `  Order #${shortId}`,
    LINE,
  ];

  for (const item of order.items) {
    const left  = `${item.qty}x ${item.name}`;
    const right = formatPrice(item.unit_price * item.qty);
    // left column: 28 chars, right column: right-aligned in remaining space
    lines.push(`  ${left.substring(0, 28).padEnd(28)}${right.padStart(10)}`);
  }

  lines.push(LINE);

  const totalRight = formatPrice(order.total);
  lines.push(`  ${'TOTAL'.padEnd(28)}${totalRight.padStart(10)}`);

  lines.push(LINE);

  if (order.payment_method === 'CASH' && order.payment_status === 'UNPAID') {
    lines.push('');
    lines.push('  *** CASH — COLLECT AT TABLE ***');
    lines.push(`  *** AMOUNT: ${formatPrice(order.total)} ***`);
  } else {
    lines.push(`  PAID  ref:${order.payment_ref?.slice(-8) ?? 'N/A'}`);
  }

  lines.push(LINE);
  lines.push('');

  console.log(JSON.stringify({ event: 'ticket_printed', order_id: order.id, table: order.table, total: order.total }));
  console.log('\n=== TICKET ===');
  console.log(lines.join('\n'));
  console.log('=== END TICKET ===\n');
}

connect();
