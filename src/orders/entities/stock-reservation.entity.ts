import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  type Relation,
} from 'typeorm';
import { CreatedAtColumn } from '../../database/columns';
import { Product } from '../../products/product.entity';
import { Order } from './order.entity';

/**
 * One row per (order, product) actually reserved. The UNIQUE constraint is the
 * database-level guarantee that a retried order never decrements stock twice.
 */
@Entity('stock_reservations')
@Unique('uq_stock_reservations_order_product', ['orderId', 'productId'])
@Index('idx_stock_reservations_product', ['productId'])
export class StockReservation {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  @Column({ name: 'order_id', type: 'char', length: 36 })
  orderId: string;

  @ManyToOne(() => Order, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'order_id',
    foreignKeyConstraintName: 'fk_stock_reservations_order',
  })
  order: Relation<Order>;

  @Column({ name: 'product_id', type: 'int', unsigned: true })
  productId: number;

  @ManyToOne(() => Product)
  @JoinColumn({
    name: 'product_id',
    foreignKeyConstraintName: 'fk_stock_reservations_product',
  })
  product: Relation<Product>;

  @Column({ type: 'int', unsigned: true })
  quantity: number;

  @CreatedAtColumn()
  createdAt: Date;
}
