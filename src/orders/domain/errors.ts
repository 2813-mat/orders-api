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

/**
 * Business failure: not enough stock for one of the products. Retrying won't
 * help, so the order goes straight to FAILED.
 */
export class InsufficientStockError extends Error {
  override readonly name = 'InsufficientStockError';

  constructor(readonly productName: string) {
    super(`estoque insuficiente: ${productName}`);
  }
}

/**
 * Technical failure injected by the exercise ("fail" in the customer name):
 * retried with backoff, then dead-lettered.
 */
export class SimulatedProcessingError extends Error {
  override readonly name = 'SimulatedProcessingError';

  constructor() {
    super('falha simulada no processamento');
  }
}
