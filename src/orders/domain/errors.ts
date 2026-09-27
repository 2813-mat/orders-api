/** A business rule rejected the order's contents (never retried). */
export class InvalidOrderError extends Error {
  override readonly name = 'InvalidOrderError';
}
