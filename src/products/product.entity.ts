import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { CreatedAtColumn, UpdatedAtColumn } from '../database/columns';

@Entity('products')
@Unique('uq_products_name', ['name'])
export class Product {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true })
  id: number;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  /** UNSIGNED + CHECK (stock >= 0) in the migration: stock can never go negative. */
  @Column({ type: 'int', unsigned: true, default: 5 })
  stock: number;

  @CreatedAtColumn()
  createdAt: Date;

  @UpdatedAtColumn()
  updatedAt: Date;
}
