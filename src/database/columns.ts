import { CreateDateColumn, UpdateDateColumn } from 'typeorm';

// TypeORM defaults to CURRENT_TIMESTAMP(6), which MySQL rejects for a
// DATETIME(3) column: the default's precision has to match the column's.
const CURRENT_TIMESTAMP_3 = 'CURRENT_TIMESTAMP(3)';

export const CreatedAtColumn = () =>
  CreateDateColumn({
    name: 'created_at',
    type: 'datetime',
    precision: 3,
    default: () => CURRENT_TIMESTAMP_3,
  });

export const UpdatedAtColumn = () =>
  UpdateDateColumn({
    name: 'updated_at',
    type: 'datetime',
    precision: 3,
    default: () => CURRENT_TIMESTAMP_3,
    onUpdate: CURRENT_TIMESTAMP_3,
  });
