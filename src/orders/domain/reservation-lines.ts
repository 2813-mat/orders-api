export interface ReservationLine {
  productId: number;
  productName: string;
  quantity: number;
}

/**
 * One line per product, in ascending product id:
 * - summing first means "Mouse 3 + Mouse 3" is checked against stock as 6 in a
 *   single conditional UPDATE, not as two checks of 3 that could both pass;
 * - a fixed order means two orders sharing products lock the rows in the same
 *   sequence, so they wait for each other instead of deadlocking.
 */
export function toReservationLines(
  items: readonly ReservationLine[],
): ReservationLine[] {
  const byProduct = new Map<number, ReservationLine>();
  for (const item of items) {
    const line = byProduct.get(item.productId);
    if (line) {
      line.quantity += item.quantity;
    } else {
      byProduct.set(item.productId, { ...item });
    }
  }
  return [...byProduct.values()].sort((a, b) => a.productId - b.productId);
}
