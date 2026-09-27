import { InsufficientStockError } from './errors';

export type FailureDecision =
  | { action: 'RETRY' }
  | {
      action: 'FAIL_PERMANENTLY';
      /** Saved as the order's failure_reason. */
      reason: string;
      /** Technical failures go to the DLQ for analysis; business ones don't. */
      deadLetter: boolean;
    };

/**
 * What to do with an order whose processing threw, on its `attempt`-th try
 * (1-based) out of `maxAttempts`:
 * - business failure (insufficient stock): won't change by retrying, fail now;
 * - anything else is treated as technical (simulated failure, DB hiccup,
 *   unknown throw): retry while attempts remain, then fail and dead-letter.
 */
export function decideFailure(
  error: unknown,
  attempt: number,
  maxAttempts: number,
): FailureDecision {
  if (error instanceof InsufficientStockError) {
    return {
      action: 'FAIL_PERMANENTLY',
      reason: error.message,
      deadLetter: false,
    };
  }
  if (attempt < maxAttempts) {
    return { action: 'RETRY' };
  }
  return {
    action: 'FAIL_PERMANENTLY',
    reason: error instanceof Error ? error.message : String(error),
    deadLetter: true,
  };
}

/** The exercise's failure trigger: "fail" anywhere in the customer name. */
export function isSimulatedFailure(customerName: string): boolean {
  return /fail/i.test(customerName);
}
