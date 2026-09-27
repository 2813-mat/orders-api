import { nextRelayDelay } from '../../../../src/outbox/domain/relay-delay';

const options = { pollIntervalMs: 500, maxBackoffMs: 30_000 };

describe('nextRelayDelay', () => {
  it('waits one poll interval after a partial batch', () => {
    expect(
      nextRelayDelay({ full: false, interrupted: false }, 500, options),
    ).toBe(500);
  });

  it('polls again right away while batches come back full', () => {
    expect(
      nextRelayDelay({ full: true, interrupted: false }, 500, options),
    ).toBe(0);
  });

  it('doubles the delay after each interrupted batch', () => {
    const interrupted = { full: false, interrupted: true };
    expect(nextRelayDelay(interrupted, 500, options)).toBe(1_000);
    expect(nextRelayDelay(interrupted, 1_000, options)).toBe(2_000);
  });

  it('backs off from the poll interval even after an immediate re-poll', () => {
    expect(nextRelayDelay({ full: true, interrupted: true }, 0, options)).toBe(
      1_000,
    );
  });

  it('caps the backoff', () => {
    expect(
      nextRelayDelay({ full: false, interrupted: true }, 20_000, options),
    ).toBe(30_000);
  });

  it('returns to the poll interval once a batch goes through', () => {
    expect(
      nextRelayDelay({ full: false, interrupted: false }, 30_000, options),
    ).toBe(500);
  });
});
