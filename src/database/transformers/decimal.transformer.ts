import { ValueTransformer } from 'typeorm';

/**
 * mysql2 returns DECIMAL columns as strings to avoid precision loss.
 * Money is DECIMAL(12,2), which fits safely in a JS number.
 */
export const decimalTransformer: ValueTransformer = {
  to: (value: number | null | undefined) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};
