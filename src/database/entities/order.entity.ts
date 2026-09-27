import { randomUUID } from 'node:crypto';
import {
  BeforeInsert,
  Column,
  Entity,
  Index,
  OneToMany,
  PrimaryColumn,
  type Relation,
} from 'typeorm';
import { CreatedAtColumn, UpdatedAtColumn } from '../columns';
import { decimalTransformer } from '../transformers/decimal.transformer';
import { OrderStatus } from '../../orders/domain/order-status.enum';
import { OrderItem } from './order-item.entity';

@Entity('orders')
@Index('idx_orders_created_at', ['createdAt', 'id'])
@Index('idx_orders_status_created', ['status', 'createdAt'])
@Index('idx_orders_created_by', ['createdBySub', 'createdAt'])
export class Order {
  /** UUID generated in the app: known before insert and hard to enumerate. */
  @PrimaryColumn({ type: 'char', length: 36 })
  id: string;

  @Column({ name: 'customer_name', type: 'varchar', length: 120 })
  customerName: string;

  @Column({
    type: 'decimal',
    precision: 12,
    scale: 2,
    transformer: decimalTransformer,
  })
  total: number;

  @Column({ type: 'enum', enum: OrderStatus, default: OrderStatus.PENDING })
  status: OrderStatus;

  @Column({
    name: 'failure_reason',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  failureReason: string | null;

  @Column({
    name: 'processing_attempts',
    type: 'int',
    unsigned: true,
    default: 0,
  })
  processingAttempts: number;

  @Column({ name: 'correlation_id', type: 'char', length: 36, nullable: true })
  correlationId: string | null;

  /** `sub` claim of the Keycloak token that created the order. */
  @Column({ name: 'created_by_sub', type: 'char', length: 36 })
  createdBySub: string;

  @OneToMany(() => OrderItem, (item) => item.order)
  items: Relation<OrderItem[]>;

  @CreatedAtColumn()
  createdAt: Date;

  @UpdatedAtColumn()
  updatedAt: Date;

  @Column({
    name: 'processed_at',
    type: 'datetime',
    precision: 3,
    nullable: true,
  })
  processedAt: Date | null;

  @BeforeInsert()
  protected assignId(): void {
    this.id ??= randomUUID();
  }
}
