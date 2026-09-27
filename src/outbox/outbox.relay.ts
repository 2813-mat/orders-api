import { InjectQueue } from '@nestjs/bullmq';
import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, EntityManager, In } from 'typeorm';
import { EnvironmentVariables } from '../config/env.validation';
import { ORDER_CREATED_EVENT } from '../orders/domain/events/order-created.event';
import { ORDERS_QUEUE } from '../orders/queue/queue.constants';
import { OutboxEvent } from '../database/entities/outbox-event.entity';
import { OutboxStatus } from './outbox-status.enum';
import { nextRelayDelay, RelayTickOutcome } from './relay-delay';

export interface RelayBatchResult extends RelayTickOutcome {
  published: number;
}

export interface OutboxBacklog {
  /** Events waiting to be published. */
  pending: number;
  /** Events the relay gave up on: need an operator. */
  failed: number;
  /** Age of the oldest PENDING event, by the database clock; null if none. */
  oldestPendingAgeMs: number | null;
}

const MAX_BACKOFF_MS = 30_000;
const LAST_ERROR_MAX_LENGTH = 500;
const BACKLOG_REPORT_INTERVAL_MS = 30_000;
/** An event older than this means orders are stuck before the queue. */
const BACKLOG_WARN_AGE_MS = 60_000;

/**
 * Moves committed outbox events to BullMQ. At-least-once: an event can be
 * published and the process die before it is marked PUBLISHED; the next tick
 * republishes it with the same jobId (deduplicated while the job is still in
 * Redis) and the consumer is idempotent for the rest.
 */
@Injectable()
export class OutboxRelay implements BeforeApplicationShutdown {
  private readonly logger = new Logger(OutboxRelay.name);
  private readonly routes: ReadonlyMap<string, Queue>;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly publishTimeoutMs: number;
  private readonly pollIntervalMs: number;

  private delayMs = 0;
  private timer?: NodeJS.Timeout;
  private currentTick?: Promise<void>;
  private backlogTimer?: NodeJS.Timeout;
  private stopping = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectQueue(ORDERS_QUEUE) ordersQueue: Queue,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.routes = new Map([[ORDER_CREATED_EVENT, ordersQueue]]);
    this.batchSize = config.get('OUTBOX_BATCH_SIZE', { infer: true });
    this.maxAttempts = config.get('OUTBOX_MAX_ATTEMPTS', { infer: true });
    this.publishTimeoutMs = config.get('OUTBOX_PUBLISH_TIMEOUT_MS', {
      infer: true,
    });
    this.pollIntervalMs = config.get('OUTBOX_POLL_INTERVAL_MS', {
      infer: true,
    });
  }

  /** Starts polling; called by the relay process only, never by the API. */
  start(): void {
    if (this.timer || this.stopping) {
      return;
    }
    this.logger.log(
      `Relaying outbox every ${this.pollIntervalMs}ms (batch ${this.batchSize})`,
    );
    this.schedule(0);
    this.backlogTimer = setInterval(
      () => void this.reportBacklog(),
      BACKLOG_REPORT_INTERVAL_MS,
    );
  }

  /** Stops polling and lets an in-flight batch commit before queues close. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    clearInterval(this.backlogTimer);
    await this.currentTick;
  }

  /**
   * How far behind the relay is. A growing `oldestPendingAgeMs` is the first
   * thing to look at when an order stays PENDING: it means the event never
   * reached the queue (Redis down, relay stopped or failing).
   */
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

  private async reportBacklog(): Promise<void> {
    try {
      const backlog = await this.backlog();
      const stuck = (backlog.oldestPendingAgeMs ?? 0) > BACKLOG_WARN_AGE_MS;
      const entry = {
        event: 'outbox.backlog',
        ...backlog,
        msg: stuck ? 'Outbox events waiting for too long' : 'Outbox backlog',
      };
      if (stuck || backlog.failed > 0) {
        this.logger.warn(entry);
      } else {
        this.logger.log(entry);
      }
    } catch (error) {
      this.logger.error(
        `Could not read the outbox backlog: ${describe(error)}`,
      );
    }
  }

  /**
   * One tick in one short transaction. SKIP LOCKED lets several relay
   * instances run side by side without picking the same event. Stops at the
   * first publish failure: when Redis is down every event would fail, and
   * trying them all would only burn their attempts.
   */
  async publishBatch(): Promise<RelayBatchResult> {
    return this.dataSource.transaction(async (manager) => {
      const events = await manager
        .getRepository(OutboxEvent)
        .createQueryBuilder('event')
        .where('event.status = :status', { status: OutboxStatus.PENDING })
        .orderBy('event.createdAt', 'ASC')
        .addOrderBy('event.id', 'ASC')
        .limit(this.batchSize)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getMany();

      const published: string[] = [];
      let interrupted = false;
      for (const event of events) {
        const queue = this.routes.get(event.eventType);
        if (!queue) {
          await this.markFailed(
            manager,
            event,
            `no queue for event type ${event.eventType}`,
          );
          continue;
        }
        try {
          await this.publish(queue, event);
          published.push(event.id);
          this.logger.log({
            event: 'order.enqueued',
            outboxEventId: event.id,
            eventType: event.eventType,
            orderId: event.aggregateId,
            correlationId: event.correlationId,
            msg: 'Outbox event published to the queue',
          });
        } catch (error) {
          await this.recordPublishFailure(manager, event, error);
          interrupted = true;
          break;
        }
      }

      if (published.length > 0) {
        await manager.update(
          OutboxEvent,
          { id: In(published) },
          {
            status: OutboxStatus.PUBLISHED,
            publishedAt: () => 'CURRENT_TIMESTAMP(3)',
          },
        );
      }
      return {
        published: published.length,
        interrupted,
        full: events.length === this.batchSize,
      };
    });
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.currentTick = this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    let outcome: RelayTickOutcome;
    try {
      const result = await this.publishBatch();
      if (result.published > 0) {
        this.logger.log(`Published ${result.published} outbox event(s)`);
      }
      outcome = result;
    } catch (error) {
      // e.g. MySQL unreachable: nothing was changed, try again later.
      this.logger.error(`Outbox relay tick failed: ${describe(error)}`);
      outcome = { full: false, interrupted: true };
    }
    this.delayMs = nextRelayDelay(outcome, this.delayMs, {
      pollIntervalMs: this.pollIntervalMs,
      maxBackoffMs: MAX_BACKOFF_MS,
    });
    if (!this.stopping) {
      this.schedule(this.delayMs);
    }
  }

  /**
   * BullMQ waits for Redis to come back instead of failing, which would hold
   * this transaction (and its row locks) open indefinitely. If the add still
   * lands after the timeout, the retry is deduplicated by the jobId.
   */
  private async publish(queue: Queue, event: OutboxEvent): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`publish timed out after ${this.publishTimeoutMs}ms`),
          ),
        this.publishTimeoutMs,
      );
    });
    try {
      await Promise.race([
        queue.add(event.eventType, event.payload, { jobId: event.id }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async recordPublishFailure(
    manager: EntityManager,
    event: OutboxEvent,
    error: unknown,
  ): Promise<void> {
    const attempts = event.attempts + 1;
    if (attempts >= this.maxAttempts) {
      await this.markFailed(manager, event, describe(error));
      return;
    }
    await manager.update(
      OutboxEvent,
      { id: event.id },
      { attempts, lastError: truncate(describe(error)) },
    );
    this.logger.warn(
      `Publishing outbox event ${event.id} failed (attempt ${attempts}/${this.maxAttempts}): ${describe(error)}`,
    );
  }

  private async markFailed(
    manager: EntityManager,
    event: OutboxEvent,
    reason: string,
  ): Promise<void> {
    await manager.update(
      OutboxEvent,
      { id: event.id },
      {
        status: OutboxStatus.FAILED,
        attempts: event.attempts + 1,
        lastError: truncate(reason),
      },
    );
    this.logger.error(
      `Outbox event ${event.id} (${event.eventType}, aggregate ${event.aggregateId}) gave up: ${reason}`,
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(message: string): string {
  return message.slice(0, LAST_ERROR_MAX_LENGTH);
}
