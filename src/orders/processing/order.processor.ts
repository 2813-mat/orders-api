import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';
import { setTimeout as sleep } from 'node:timers/promises';
import { EnvironmentVariables } from '../../config/env.validation';
import { runWithCorrelationId } from '../../common/correlation/correlation-id';
import {
  InsufficientStockError,
  SimulatedProcessingError,
} from '../domain/errors';
import { decideFailure, isSimulatedFailure } from '../domain/failure-policy';
import { OrderStatus } from '../domain/order-status.enum';
import {
  ORDER_FAILED_JOB,
  OrderDeadLetterData,
  OrderJobData,
  ORDERS_DEAD_LETTER_QUEUE,
  ORDERS_QUEUE,
} from '../queue/queue.constants';
import { OrderProcessingService } from './order-processing.service';
import { simulatedWorkMs } from './simulated-work';

/**
 * Consumes `orders`. The job only carries the order id: everything else is
 * re-read from MySQL, the source of truth.
 */
@Processor(ORDERS_QUEUE)
export class OrderProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(OrderProcessor.name);

  constructor(
    private readonly processing: OrderProcessingService,
    private readonly config: ConfigService<EnvironmentVariables, true>,
    @InjectQueue(ORDERS_DEAD_LETTER_QUEUE)
    private readonly deadLetter: Queue<OrderDeadLetterData>,
  ) {
    super();
  }

  /** The decorator is static; the concurrency comes from validated env. */
  onApplicationBootstrap(): void {
    this.worker.concurrency = this.config.get('WORKER_CONCURRENCY', {
      infer: true,
    });
  }

  async process(job: Job<OrderJobData>): Promise<void> {
    // Every log line of this job carries the id of the request that created
    // the order (it travelled API -> outbox -> job payload).
    return runWithCorrelationId(job.data.correlationId, () =>
      this.processOrder(job),
    );
  }

  private async processOrder(job: Job<OrderJobData>): Promise<void> {
    const { orderId } = job.data;
    const attempt = job.attemptsMade + 1;
    const startedAt = Date.now();

    const order = await this.processing.findForProcessing(orderId);
    if (!order) {
      this.logger.warn({
        event: 'order.processing.skipped',
        orderId,
        msg: 'Order not found, nothing to do',
      });
      return;
    }
    if (order.status !== OrderStatus.PENDING) {
      this.logger.log({
        event: 'order.processing.skipped',
        orderId,
        status: order.status,
        msg: `Order already ${order.status}, nothing to do`,
      });
      return;
    }
    await this.processing.recordAttempt(orderId);
    this.logger.log({
      event: 'order.processing.started',
      orderId,
      attempt,
      jobId: job.id,
      msg: 'Processing order',
    });

    try {
      // Stands in for slow external work. Outside any transaction on purpose:
      // holding row locks for 1-2s would serialize every order on those rows.
      await sleep(
        simulatedWorkMs(
          this.config.get('PROCESSING_MIN_MS', { infer: true }),
          this.config.get('PROCESSING_MAX_MS', { infer: true }),
        ),
      );
      if (isSimulatedFailure(order.customerName)) {
        throw new SimulatedProcessingError();
      }
      const outcome = await this.processing.reserveAndConfirm(orderId);
      this.logger.log({
        event: 'order.processing.completed',
        orderId,
        attempt,
        outcome,
        durationMs: Date.now() - startedAt,
        msg: `Order ${outcome}`,
      });
    } catch (error) {
      await this.handleFailure(job, error);
    }
  }

  /**
   * RETRY rethrows so BullMQ reschedules the job with backoff. A permanent
   * technical failure is copied to the DLQ *before* the order is marked
   * FAILED: if the worker dies in between, the rerun sees a PENDING order and
   * the DLQ copy is deduplicated by its jobId. A business failure (no stock)
   * completes the job: there is nothing to retry or to analyse.
   */
  private async handleFailure(
    job: Job<OrderJobData>,
    error: unknown,
  ): Promise<void> {
    const { orderId, correlationId } = job.data;
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;
    const decision = decideFailure(error, attempt, maxAttempts);

    if (decision.action === 'RETRY') {
      this.logger.warn({
        event: 'order.processing.retry',
        orderId,
        attempt,
        maxAttempts,
        delayMs: retryDelayMs(job, attempt),
        error: describe(error),
        msg: 'Processing failed, will retry',
      });
      throw error;
    }

    if (decision.deadLetter) {
      await this.deadLetter.add(
        ORDER_FAILED_JOB,
        {
          orderId,
          correlationId,
          reason: decision.reason,
          attempts: attempt,
          failedAt: new Date().toISOString(),
        },
        { jobId: `${orderId}-${job.id}` },
      );
    }
    await this.processing.markFailed(orderId, decision.reason);
    if (error instanceof InsufficientStockError) {
      this.logger.log({
        event: 'order.stock.insufficient',
        orderId,
        attempt,
        product: error.productName,
        msg: 'Order FAILED: not enough stock',
      });
    } else {
      this.logger.error({
        event: 'order.processing.failed',
        orderId,
        attempt,
        maxAttempts,
        reason: decision.reason,
        deadLettered: decision.deadLetter,
        msg: 'Order FAILED after exhausting its attempts',
      });
    }

    if (decision.deadLetter) {
      throw error; // the original job also ends up in BullMQ's failed set
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What BullMQ will wait before the next attempt (for the retry log only). */
function retryDelayMs(job: Job, attempt: number): number | undefined {
  const { backoff } = job.opts;
  if (typeof backoff === 'number') {
    return backoff;
  }
  if (!backoff?.delay) {
    return undefined;
  }
  return backoff.type === 'exponential'
    ? backoff.delay * 2 ** (attempt - 1)
    : backoff.delay;
}
