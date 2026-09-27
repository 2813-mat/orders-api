import { InvalidOrderError } from './errors';

export interface PricedLine {
  quantity: number;
  unitPrice: number;
}

export interface OrderTotals {
  /** One per line, same order as the input. */
  subtotals: number[];
  total: number;
}

/**
 * Money math in integer cents: `0.1 + 0.2` in floats is `0.30000000000000004`,
 * in cents it is `10 + 20 = 30`. Only the final values go back to reais.
 * Re-validates the lines on purpose — the DTO is not the only possible caller.
 */
export function calculateOrderTotals(
  lines: readonly PricedLine[],
): OrderTotals {
  if (lines.length === 0) {
    throw new InvalidOrderError('order must have at least one item');
  }

  const subtotalsInCents = lines.map((line, index) => {
    assertValidQuantity(line.quantity, index);
    return toCents(line.unitPrice, index) * line.quantity;
  });
  const totalInCents = subtotalsInCents.reduce((sum, cents) => sum + cents, 0);

  if (!Number.isSafeInteger(totalInCents)) {
    throw new InvalidOrderError('order total is too large');
  }

  return {
    subtotals: subtotalsInCents.map(fromCents),
    total: fromCents(totalInCents),
  };
}

function assertValidQuantity(quantity: number, index: number): void {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new InvalidOrderError(
      `item ${index}: quantity must be a positive integer`,
    );
  }
}

function toCents(price: number, index: number): number {
  if (!Number.isFinite(price) || price < 0) {
    throw new InvalidOrderError(
      `item ${index}: price must be a non-negative number`,
    );
  }
  const cents = Math.round(price * 100);
  // 19.99 * 100 is 1998.9999999999998, so compare with a tolerance; anything
  // further off has a third decimal place that DECIMAL(12,2) would round away.
  if (Math.abs(price * 100 - cents) > 1e-6) {
    throw new InvalidOrderError(
      `item ${index}: price must have at most 2 decimal places`,
    );
  }
  return cents;
}

function fromCents(cents: number): number {
  return cents / 100;
}
