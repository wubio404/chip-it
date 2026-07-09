'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { adminOrderStreamUrl, fetchTodaysOrders } from '@/lib/api';
import type { AdminOrder } from '@/lib/api';

const MAX_CONSECUTIVE_FAILURES = 5;
// Safety-net poll: if SSE silently stalls (a real, documented failure mode — the
// browser doesn't always detect a half-open connection), this keeps the list
// correct even when no live 'order' event ever arrives. It's what makes a page
// refresh reliably correct regardless of whether SSE itself is working: the very
// first thing on mount is this authoritative JSON read, not a wait-for-SSE.
const POLL_INTERVAL_MS = 20_000;

function updatedAtMs(o: AdminOrder): number {
  return new Date(o.updated_at).getTime();
}

// Diagnostic logging — every connect/open/error/close and every event's
// server-emit-to-receive latency, so a real browser session leaves a trail.
function log(msg: string, data?: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[sse] ${msg}`, data ?? '');
}

// Live order feed over SSE, backed by the plain JSON list as ground truth.
// EventSource's native auto-reconnect would replay an expired cookie forever, so
// on error we close it explicitly, refresh the access token once, then open
// exactly one new EventSource — never two connections at once.
export function useOrderStream(venueId: string, venueSlug: string) {
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [connected, setConnected] = useState(false);
  const [sseGaveUp, setSseGaveUp] = useState(false);

  const esRef = useRef<EventSource | null>(null);
  const reconnectingRef = useRef(false);
  const failuresRef = useRef(0);
  const connectCountRef = useRef(0);

  // Authoritative full-list replace (initial load, SSE 'snapshot', safety-net
  // poll). Merged per-row by updated_at so a response that happens to reflect
  // an earlier moment than what's already on screen can never revert a row —
  // this is what stops the "flips back, then re-settles" flicker regardless of
  // which channel (poll vs SSE) is slower on any given round.
  const applySnapshot = useCallback((list: AdminOrder[]) => {
    setOrders((prev) => {
      const prevById = new Map(prev.map((o) => [o.id, o]));
      const merged = list.map((incoming) => {
        const existing = prevById.get(incoming.id);
        return !existing || updatedAtMs(incoming) >= updatedAtMs(existing) ? incoming : existing;
      });
      return merged.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    });
  }, []);

  const upsert = useCallback((order: AdminOrder) => {
    setOrders((prev) => {
      const idx = prev.findIndex((o) => o.id === order.id);
      if (idx === -1) return [order, ...prev].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      if (updatedAtMs(order) < updatedAtMs(prev[idx])) {
        log('stale order event ignored', { order_id: order.id, incoming_updated_at: order.updated_at, held_updated_at: prev[idx].updated_at });
        return prev; // a delayed/buffered older event landed after a newer one — drop it
      }
      const next = [...prev];
      next[idx] = order;
      return next.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    });
  }, []);

  const poll = useCallback(async () => {
    try {
      applySnapshot(await fetchTodaysOrders(venueId));
    } catch {
      // Transient — the next poll (or a working SSE connection) will catch up.
    }
  }, [venueId, applySnapshot]);

  const connectRef = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }

      const connectId = ++connectCountRef.current;
      const openedAt = Date.now();
      log('connecting', { connectId, url: adminOrderStreamUrl(venueId) });

      const es = new EventSource(adminOrderStreamUrl(venueId), { withCredentials: true });
      esRef.current = es;

      es.onopen = () => {
        log('open', { connectId, ms_to_open: Date.now() - openedAt });
      };

      es.addEventListener('snapshot', (e: MessageEvent) => {
        const list = JSON.parse(e.data as string) as AdminOrder[];
        log('snapshot received', { connectId, count: list.length });
        applySnapshot(list);
        setConnected(true);
        setSseGaveUp(false);
        failuresRef.current = 0;
      });

      es.addEventListener('order', (e: MessageEvent) => {
        const order = JSON.parse(e.data as string) as AdminOrder & { _emitted_at?: string };
        const latencyMs = order._emitted_at ? Date.now() - new Date(order._emitted_at).getTime() : null;
        log('order event received', { connectId, order_id: order.id, status: order.status, emit_to_receive_ms: latencyMs });
        upsert(order);
      });

      es.onerror = () => {
        // EventSource.readyState: 0=CONNECTING, 1=OPEN, 2=CLOSED. This tells us
        // whether the error happened before we ever connected, mid-stream after
        // a working connection, or after the browser already gave up.
        log('error', { connectId, readyState: es.readyState, ms_alive: Date.now() - openedAt });
        setConnected(false);
        es.close(); // stop native auto-reconnect before it retries with a stale cookie
        if (esRef.current !== es || cancelled) return;
        esRef.current = null;

        if (reconnectingRef.current) return; // never let two reconnect attempts run
        failuresRef.current += 1;
        if (failuresRef.current > MAX_CONSECUTIVE_FAILURES) {
          // Give up on SSE, but the panel keeps working off the safety-net poll —
          // surface this so staff know live updates are degraded, with a manual retry.
          log('giving up after repeated failures', { connectId, failures: failuresRef.current });
          setSseGaveUp(true);
          return;
        }

        reconnectingRef.current = true;
        (async () => {
          try {
            const res = await fetch('/api-proxy/auth/refresh', { method: 'POST', credentials: 'include' });
            if (!res.ok) throw new Error('refresh_failed');
            reconnectingRef.current = false;
            log('reconnecting after refresh', { connectId, failures: failuresRef.current });
            connect(); // exactly one new EventSource
          } catch {
            reconnectingRef.current = false;
            log('refresh failed, redirecting to login', { connectId });
            if (typeof window !== 'undefined') window.location.href = `/admin/${venueSlug}/login`;
          }
        })();
      };
    }

    connectRef.current = connect;

    // Authoritative initial read — never wait on SSE to know "what's true right
    // now". This is what makes a page refresh correct even if SSE never connects.
    void poll();
    connect();

    const pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(pollTimer);
      esRef.current?.close();
      esRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venueId, venueSlug]);

  const retry = useCallback(() => {
    failuresRef.current = 0;
    setSseGaveUp(false);
    void poll();
    connectRef.current();
  }, [poll]);

  return { orders, connected, sseGaveUp, retry };
}
