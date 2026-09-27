export interface RelayTickOutcome {
  /** The batch was full: more events are probably waiting. */
  full: boolean;
  /** A publish failed and the rest of the batch was left for later. */
  interrupted: boolean;
}

export interface RelayDelayOptions {
  pollIntervalMs: number;
  maxBackoffMs: number;
}

/**
 * How long the relay sleeps before the next tick: drain a backlog without
 * waiting, back off exponentially while publishing fails (e.g. Redis down),
 * otherwise poll at the regular interval.
 */
export function nextRelayDelay(
  outcome: RelayTickOutcome,
  previousDelayMs: number,
  { pollIntervalMs, maxBackoffMs }: RelayDelayOptions,
): number {
  if (outcome.interrupted) {
    return Math.min(
      Math.max(previousDelayMs, pollIntervalMs) * 2,
      maxBackoffMs,
    );
  }
  return outcome.full ? 0 : pollIntervalMs;
}
