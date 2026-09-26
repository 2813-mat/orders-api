import { decimalTransformer } from '../../../../src/database/transformers/decimal.transformer';

describe('decimalTransformer', () => {
  it('converts the DECIMAL string returned by mysql2 into a number', () => {
    expect(decimalTransformer.from('1234.50')).toBe(1234.5);
    expect(decimalTransformer.from('0.00')).toBe(0);
  });

  it('keeps null for nullable columns', () => {
    expect(decimalTransformer.from(null)).toBeNull();
  });

  it('writes the number as is', () => {
    expect(decimalTransformer.to(19.9)).toBe(19.9);
  });
});
