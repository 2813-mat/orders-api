/** A business rule rejected the order's contents (never retried). */
export class InvalidOrderError extends Error {
  override readonly name: string = 'InvalidOrderError';
}

/** The order references products that are not in the catalog. */
export class UnknownProductsError extends InvalidOrderError {
  override readonly name: string = 'UnknownProductsError';

  constructor(readonly productNames: string[]) {
    super(`unknown products: ${productNames.join(', ')}`);
  }
}
