import { toReservationLines } from '../../../../src/orders/domain/reservation-lines';

describe('toReservationLines', () => {
  it('adds up repeated products into a single line', () => {
    expect(
      toReservationLines([
        { productId: 2, productName: 'Mouse', quantity: 3 },
        { productId: 2, productName: 'Mouse', quantity: 3 },
      ]),
    ).toEqual([{ productId: 2, productName: 'Mouse', quantity: 6 }]);
  });

  it('sorts lines by product id so concurrent orders lock rows in the same order', () => {
    expect(
      toReservationLines([
        { productId: 3, productName: 'Teclado', quantity: 1 },
        { productId: 1, productName: 'Notebook', quantity: 2 },
        { productId: 2, productName: 'Mouse', quantity: 1 },
        { productId: 1, productName: 'Notebook', quantity: 1 },
      ]).map((line) => [line.productId, line.quantity]),
    ).toEqual([
      [1, 3],
      [2, 1],
      [3, 1],
    ]);
  });

  it('returns nothing for no items', () => {
    expect(toReservationLines([])).toEqual([]);
  });
});
