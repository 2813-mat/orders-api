import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { OutboxEvent } from '../../database/entities/outbox-event.entity';
import { Transaction } from '../../database/transaction-runner';
import { OutboxStatus } from '../domain/outbox-status.enum';

export type NewOutboxEvent = Pick<
  OutboxEvent,
  'aggregateType' | 'aggregateId' | 'eventType' | 'payload' | 'correlationId'
>;

export interface OutboxBacklog {
  /** Events waiting to be published. */
  pending: number;
  /** Events the relay gave up on: need an operator. */
  failed: number;
  /** Age of the oldest PENDING event, by the database clock; null if none. */
  oldestPendingAgeMs: number | null;
}

/** last_error is VARCHAR(500). */
const LAST_ERROR_MAX_LENGTH = 500;

@Injectable()
export class OutboxEventsRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  insert(tx: Transaction, event: NewOutboxEvent): Promise<OutboxEvent> {
    return tx.save(tx.create(OutboxEvent, event));
  }

  /**
   * Oldest PENDING events, locked with `FOR UPDATE SKIP LOCKED`: rows another
   * relay instance already holds are skipped instead of waited for, so
   * instances running side by side never pick the same event.
   */
  lockPendingBatch(tx: Transaction, limit: number): Promise<OutboxEvent[]> {
    return tx
      .getRepository(OutboxEvent)
      .createQueryBuilder('event')
      .where('event.status = :status', { status: OutboxStatus.PENDING })
      .orderBy('event.createdAt', 'ASC')
      .addOrderBy('event.id', 'ASC')
      .limit(limit)
      .setLock('pessimistic_write')
      .setOnLocked('skip_locked')
      .getMany();
  }

  async markPublished(tx: Transaction, ids: string[]): Promise<void> {
    await tx.update(
      OutboxEvent,
      { id: In(ids) },
      {
        status: OutboxStatus.PUBLISHED,
        publishedAt: () => 'CURRENT_TIMESTAMP(3)',
      },
    );
  }

  /** Stays PENDING for another try. */
  async recordFailedAttempt(
    tx: Transaction,
    id: string,
    attempts: number,
    error: string,
  ): Promise<void> {
    await tx.update(
      OutboxEvent,
      { id },
      { attempts, lastError: error.slice(0, LAST_ERROR_MAX_LENGTH) },
    );
  }

  async markFailed(
    tx: Transaction,
    id: string,
    attempts: number,
    reason: string,
  ): Promise<void> {
    await tx.update(
      OutboxEvent,
      { id },
      {
        status: OutboxStatus.FAILED,
        attempts,
        lastError: reason.slice(0, LAST_ERROR_MAX_LENGTH),
      },
    );
  }

  async backlog(): Promise<OutboxBacklog> {
    const [row] = await this.dataSource.query<
      Array<{
        pending: string | null;
        failed: string | null;
        oldestPendingAgeMs: string | null;
      }>
    >(
      `SELECT SUM(status = ?) AS pending,
              SUM(status = ?) AS failed,
              TIMESTAMPDIFF(MICROSECOND,
                            MIN(CASE WHEN status = ? THEN created_at END),
                            NOW(3)) DIV 1000 AS oldestPendingAgeMs
         FROM outbox_events
        WHERE status IN (?, ?)`,
      [
        OutboxStatus.PENDING,
        OutboxStatus.FAILED,
        OutboxStatus.PENDING,
        OutboxStatus.PENDING,
        OutboxStatus.FAILED,
      ],
    );
    return {
      pending: Number(row.pending ?? 0),
      failed: Number(row.failed ?? 0),
      oldestPendingAgeMs:
        row.oldestPendingAgeMs === null ? null : Number(row.oldestPendingAgeMs),
    };
  }
}
