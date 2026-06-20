// Normative interfaces from spec Section 5.4 — do not modify without flagging why.

export interface CanonicalOrder {
  id: string;
  venue_id: string;
  table: string;             // human-readable label ("Table 7") — snapshotted at order time
  customer_name?: string;
  payment_method: 'CARD' | 'APPLE_PAY' | 'CASH';
  payment_status: 'UNPAID' | 'PAID' | 'REFUNDED' | 'VOIDED';
  items: Array<{
    sku: string;
    pos_sku?: string;
    name: string;
    qty: number;
    unit_price: number;    // tax-inclusive, integer piastres
  }>;
  total: number;           // tax-inclusive, integer piastres
  paid_at?: string;        // absent for unpaid cash orders
  payment_ref?: string;    // absent for cash
}

export interface ConnectorResult {
  ok: boolean;
  tier: 'foodics' | 'db_injector' | 'print';
  pos_ref?: string;   // POS order id on success
  error?: string;     // human-readable reason on failure
}

export interface PosConnector {
  readonly name: string;
  inject(order: CanonicalOrder, venue: VenueConfig): Promise<ConnectorResult>;
}

// Minimal venue shape passed to connectors — connectors must not reach into the DB.
export interface VenueConfig {
  id: string;
  slug: string;
  pos_type: 'FOODICS' | 'DB_INJECTOR' | 'PRINT_FALLBACK';
  pos_credentials?: Record<string, unknown>;
  db_config?: Record<string, unknown>;
  paymob_config?: Record<string, unknown>;
}
