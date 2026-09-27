import { InvalidOrderError } from '../../../../src/orders/domain/errors';
import { calculateOrderTotals } from '../../../../src/orders/domain/order-total';

describe('calculateOrderTotals', () => {
  it('sums the subtotals of several items', () => {
    expect(
      calculateOrderTotals([
        { quantity: 2, unitPrice: 10 },
        { quantity: 1, unitPrice: 5.5 },
        { quantity: 3, unitPrice: 0.99 },
      ]),
    ).toEqual({ subtotals: [20, 5.5, 2.97], total: 28.47 });
  });

  it('is exact where float math is not: 0.1 + 0.2 = 0.30', () => {
    expect(0.1 + 0.2).not.toBe(0.3);

    expect(
      calculateOrderTotals([
        { quantity: 1, unitPrice: 0.1 },
        { quantity: 1, unitPrice: 0.2 },
      ]),
    ).toEqual({ subtotals: [0.1, 0.2], total: 0.3 });
  });

  it('keeps cents exact across quantities: 0.1 × 3 + 0.2 = 0.50', () => {
    expect(0.1 * 3).not.toBe(0.3);

    expect(
      calculateOrderTotals([
        { quantity: 3, unitPrice: 0.1 },
        { quantity: 1, unitPrice: 0.2 },
      ]),
    ).toEqual({ subtotals: [0.3, 0.2], total: 0.5 });
  });

  it('handles large quantities of prices with cents', () => {
    expect(
      calculateOrderTotals([{ quantity: 100_000, unitPrice: 19.99 }]),
    ).toEqual({ subtotals: [1_999_000], total: 1_999_000 });
  });

  it('accepts free items', () => {
    expect(calculateOrderTotals([{ quantity: 2, unitPrice: 0 }])).toEqual({
      subtotals: [0],
      total: 0,
    });
  });

  it('rejects an empty order', () => {
    expect(() => calculateOrderTotals([])).toThrow(
      new InvalidOrderError('order must have at least one item'),
    );
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects quantity %p', (quantity) => {
    expect(() => calculateOrderTotals([{ quantity, unitPrice: 1 }])).toThrow(
      new InvalidOrderError('item 0: quantity must be a positive integer'),
    );
  });

  it.each([-0.01, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects price %p',
    (unitPrice) => {
      expect(() => calculateOrderTotals([{ quantity: 1, unitPrice }])).toThrow(
        new InvalidOrderError('item 0: price must be a non-negative number'),
      );
    },
  );

  it('rejects prices with more than 2 decimal places', () => {
    expect(() =>
      calculateOrderTotals([{ quantity: 1, unitPrice: 10.005 }]),
    ).toThrow(
      new InvalidOrderError('item 0: price must have at most 2 decimal places'),
    );
  });

  it('points at the offending item', () => {
    expect(() =>
      calculateOrderTotals([
        { quantity: 1, unitPrice: 1 },
        { quantity: 0, unitPrice: 1 },
      ]),
    ).toThrow('item 1: quantity must be a positive integer');
  });

  it('accepts the largest total DECIMAL(12,2) can store', () => {
    expect(
      calculateOrderTotals([{ quantity: 1, unitPrice: 9_999_999_999.99 }]),
    ).toEqual({ subtotals: [9_999_999_999.99], total: 9_999_999_999.99 });
  });

  it('rejects totals DECIMAL(12,2) cannot store', () => {
    expect(() =>
      calculateOrderTotals([
        { quantity: 1, unitPrice: 9_999_999_999.99 },
        { quantity: 1, unitPrice: 0.01 },
      ]),
    ).toThrow(new InvalidOrderError('order total is too large'));
  });
});
