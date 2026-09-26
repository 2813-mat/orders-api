import { randomUUID } from 'node:crypto';
import { BeforeInsert, Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { CreatedAtColumn } from '../database/columns';
import { OutboxStatus } from './outbox-status.enum';

@Entity('outbox_events')
@Index('idx_outbox_status_created', ['status', 'createdAt'])
@Index('idx_outbox_aggregate', ['aggregateId'])
export class OutboxEvent {
  /** Also used as the BullMQ jobId, so republishing the same event is deduplicated. */
  @PrimaryColumn({ type: 'char', length: 36 })
  id: string;

  @Column({ name: 'aggregate_type', type: 'varchar', length: 50 })
  aggregateType: string;

  @Column({ name: 'aggregate_id', type: 'char', length: 36 })
  aggregateId: string;

  @Column({ name: 'event_type', type: 'varchar', length: 100 })
  eventType: string;

  @Column({ type: 'json' })
  payload: Record<string, unknown>;

  @Column({ name: 'correlation_id', type: 'char', length: 36, nullable: true })
  correlationId: string | null;

  @Column({ type: 'enum', enum: OutboxStatus, default: OutboxStatus.PENDING })
  status: OutboxStatus;

  @Column({ type: 'int', unsigned: true, default: 0 })
  attempts: number;

  @Column({ name: 'last_error', type: 'varchar', length: 500, nullable: true })
  lastError: string | null;

  @CreatedAtColumn()
  createdAt: Date;

  @Column({
    name: 'published_at',
    type: 'datetime',
    precision: 3,
    nullable: true,
  })
  publishedAt: Date | null;

  @BeforeInsert()
  protected assignId(): void {
    this.id ??= randomUUID();
  }
}
