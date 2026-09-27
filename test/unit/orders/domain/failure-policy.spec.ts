import {
  InsufficientStockError,
  SimulatedProcessingError,
} from '../../../../src/orders/domain/errors';
import {
  decideFailure,
  isSimulatedFailure,
} from '../../../../src/orders/domain/failure-policy';

describe('decideFailure', () => {
  const technical = new SimulatedProcessingError();

  it('retries a technical error on attempt 1 of 3', () => {
    expect(decideFailure(technical, 1, 3)).toEqual({ action: 'RETRY' });
  });

  it('retries a technical error on attempt 2 of 3', () => {
    expect(decideFailure(new Error('db timeout'), 2, 3)).toEqual({
      action: 'RETRY',
    });
  });

  it('gives up on the last attempt, keeping the message and dead-lettering', () => {
    expect(decideFailure(technical, 3, 3)).toEqual({
      action: 'FAIL_PERMANENTLY',
      reason: technical.message,
      deadLetter: true,
    });
  });

  it('gives up right away on insufficient stock, without dead-lettering', () => {
    expect(decideFailure(new InsufficientStockError('Mouse'), 1, 3)).toEqual({
      action: 'FAIL_PERMANENTLY',
      reason: 'estoque insuficiente: Mouse',
      deadLetter: false,
    });
  });

  it('treats something that is not an Error as a technical failure', () => {
    expect(decideFailure('boom', 1, 3)).toEqual({ action: 'RETRY' });
    expect(decideFailure('boom', 3, 3)).toEqual({
      action: 'FAIL_PERMANENTLY',
      reason: 'boom',
      deadLetter: true,
    });
  });

  it('never retries when only one attempt is allowed', () => {
    expect(decideFailure(technical, 1, 1)).toMatchObject({
      action: 'FAIL_PERMANENTLY',
    });
  });
});

describe('isSimulatedFailure', () => {
  it.each(['fail', 'FAIL', 'Cliente Fail', 'failure', 'Maria failing'])(
    'is true for %p',
    (name) => expect(isSimulatedFailure(name)).toBe(true),
  );

  it.each(['Maria', 'Fa il', 'Fábio'])('is false for %p', (name) =>
    expect(isSimulatedFailure(name)).toBe(false),
  );
});
