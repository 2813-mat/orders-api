import {
  CORRELATION_ID_HEADER,
  currentCorrelationId,
  resolveCorrelationId,
  runWithCorrelationId,
} from '../../../../src/common/correlation/correlation-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const aRequest = (header?: string | string[]) => ({
  headers: header === undefined ? {} : { [CORRELATION_ID_HEADER]: header },
});

describe('resolveCorrelationId', () => {
  it('keeps a UUID sent by the caller, lower-cased', () => {
    expect(
      resolveCorrelationId(aRequest('0B9C7A1E-2D3F-4A5B-8C6D-7E8F9A0B1C2D')),
    ).toBe('0b9c7a1e-2d3f-4a5b-8c6d-7e8f9a0b1c2d');
  });

  it.each([
    ['missing', undefined],
    ['not a UUID', 'abc'],
    ['too long', `${'a'.repeat(36)}-extra`],
    ['sent twice', ['0b9c7a1e-2d3f-4a5b-8c6d-7e8f9a0b1c2d', 'x']],
  ])('generates a new one when the header is %s', (_case, header) => {
    expect(resolveCorrelationId(aRequest(header))).toMatch(UUID);
  });

  it('answers the same id for the same request, however many times it is asked', () => {
    const request = aRequest();

    expect(resolveCorrelationId(request)).toBe(resolveCorrelationId(request));
  });

  it('gives different requests different ids', () => {
    expect(resolveCorrelationId(aRequest())).not.toBe(
      resolveCorrelationId(aRequest()),
    );
  });
});

describe('runWithCorrelationId', () => {
  it('exposes the id to everything awaited inside, and only there', async () => {
    expect(currentCorrelationId()).toBeUndefined();

    const seen = await runWithCorrelationId('corr-1', async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return currentCorrelationId();
    });

    expect(seen).toBe('corr-1');
    expect(currentCorrelationId()).toBeUndefined();
  });

  it('keeps concurrent contexts apart', async () => {
    const read = (id: string, delayMs: number) =>
      runWithCorrelationId(id, async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return currentCorrelationId();
      });

    await expect(Promise.all([read('a', 20), read('b', 5)])).resolves.toEqual([
      'a',
      'b',
    ]);
  });
});
