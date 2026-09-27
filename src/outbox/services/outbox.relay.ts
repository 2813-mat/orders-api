import { InjectQueue } from '@nestjs/bullmq';
import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { EnvironmentVariables } from '../../config/env.validation';
import { OutboxEvent } from '../../database/entities/outbox-event.entity';
import {
  Transaction,
  TransactionRunner,
} from '../../database/transaction-runner';
import { ORDER_CREATED_EVENT } from '../../orders/domain/events/order-created.event';
import { ORDERS_QUEUE } from '../../orders/queue/queue.constants';
import { nextRelayDelay, RelayTickOutcome } from '../domain/relay-delay';
import {
  OutboxBacklog,
  OutboxEventsRepository,
} from '../repositories/outbox-events.repository';

export interface RelayBatchResult extends RelayTickOutcome {
  published: number;
}

const MAX_BACKOFF_MS = 30_000;
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
    private readonly transactions: TransactionRunner,
    private readonly events: OutboxEventsRepository,
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
  backlog(): Promise<OutboxBacklog> {
    return this.events.backlog();
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
    return this.transactions.run(async (tx) => {
      const events = await this.events.lockPendingBatch(tx, this.batchSize);

      const published: string[] = [];
      let interrupted = false;
      for (const event of events) {
        const queue = this.routes.get(event.eventType);
        if (!queue) {
          await this.markFailed(
            tx,
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
          await this.recordPublishFailure(tx, event, error);
          interrupted = true;
          break;
        }
      }

      if (published.length > 0) {
        await this.events.markPublished(tx, published);
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
    tx: Transaction,
    event: OutboxEvent,
    error: unknown,
  ): Promise<void> {
    const attempts = event.attempts + 1;
    if (attempts >= this.maxAttempts) {
      await this.markFailed(tx, event, describe(error));
      return;
    }
    await this.events.recordFailedAttempt(
      tx,
      event.id,
      attempts,
      describe(error),
    );
    this.logger.warn(
      `Publishing outbox event ${event.id} failed (attempt ${attempts}/${this.maxAttempts}): ${describe(error)}`,
    );
  }

  private async markFailed(
    tx: Transaction,
    event: OutboxEvent,
    reason: string,
  ): Promise<void> {
    await this.events.markFailed(tx, event.id, event.attempts + 1, reason);
    this.logger.error(
      `Outbox event ${event.id} (${event.eventType}, aggregate ${event.aggregateId}) gave up: ${reason}`,
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
