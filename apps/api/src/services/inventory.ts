import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

export interface InventoryItem {
  sku: string;
  qty: number;
}

// Lock rows in consistent sku order to prevent deadlocks between concurrent transactions.
function sorted(items: InventoryItem[]): InventoryItem[] {
  return [...items].sort((a, b) => a.sku.localeCompare(b.sku));
}

// Reserve stock for items in a new order. Must be called inside a Prisma $transaction.
// Throws on item not found, item unavailable, or insufficient stock.
export async function reserveStock(tx: Tx, venueId: string, items: InventoryItem[]): Promise<void> {
  for (const { sku, qty } of sorted(items)) {
    const rows = await tx.$queryRaw<Array<{
      id: string;
      stock_count: number | null;
      reserved_count: number;
      available: boolean;
    }>>`
      SELECT id, stock_count, reserved_count, available
      FROM "MenuItem"
      WHERE venue_id = ${venueId} AND sku = ${sku}
      FOR UPDATE
    `;

    if (rows.length === 0) throw Object.assign(new Error(`item_not_found`), { sku });
    const row = rows[0];

    if (!row.available) throw Object.assign(new Error(`item_unavailable`), { sku });

    if (row.stock_count !== null) {
      const effective = row.stock_count - row.reserved_count;
      if (effective < qty) throw Object.assign(new Error(`insufficient_stock`), { sku, available: effective });
    }

    const newReserved = row.reserved_count + qty;
    const autoDisable = row.stock_count !== null && row.stock_count - newReserved <= 0;

    await tx.menuItem.update({
      where: { id: row.id },
      data: {
        reserved_count: { increment: qty },
        ...(autoDisable ? { available: false } : {}),
      },
    });
  }
}

// Commit stock on CONFIRMED: decrement stock_count and reserved_count.
// The reservation is converted to a real sale. Must be called inside a $transaction.
export async function commitStock(tx: Tx, venueId: string, items: InventoryItem[]): Promise<void> {
  for (const { sku, qty } of sorted(items)) {
    const rows = await tx.$queryRaw<Array<{
      id: string;
      stock_count: number | null;
    }>>`
      SELECT id, stock_count
      FROM "MenuItem"
      WHERE venue_id = ${venueId} AND sku = ${sku}
      FOR UPDATE
    `;

    if (rows.length === 0) throw Object.assign(new Error(`item_not_found`), { sku });
    const row = rows[0];

    await tx.menuItem.update({
      where: { id: row.id },
      data: {
        reserved_count: { decrement: qty },
        ...(row.stock_count !== null ? { stock_count: { decrement: qty } } : {}),
      },
    });
  }
}

// Release a reservation without decrementing stock_count.
// Used for CANCELLED and EXPIRED orders. Must be called inside a $transaction.
// Safe to call exactly once per order (caller must hold the order row lock and verify
// status === CREATED before calling — prevents double-release going negative).
export async function releaseReservation(tx: Tx, venueId: string, items: InventoryItem[]): Promise<void> {
  for (const { sku, qty } of sorted(items)) {
    const rows = await tx.$queryRaw<Array<{
      id: string;
      reserved_count: number;
    }>>`
      SELECT id, reserved_count
      FROM "MenuItem"
      WHERE venue_id = ${venueId} AND sku = ${sku}
      FOR UPDATE
    `;

    if (rows.length === 0) continue; // item may have been deleted; skip gracefully
    const row = rows[0];

    // Clamp to 0 — safety net against any double-release edge case
    const newReserved = Math.max(0, row.reserved_count - qty);

    await tx.menuItem.update({
      where: { id: row.id },
      data: { reserved_count: newReserved },
    });
  }
}
