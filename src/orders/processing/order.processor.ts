import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';
import { setTimeout as sleep } from 'node:timers/promises';
import { EnvironmentVariables } from '../../config/env.validation';
import { SimulatedProcessingError } from '../domain/errors';
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
    const { orderId } = job.data;

    const order = await this.processing.findForProcessing(orderId);
    if (!order) {
      this.logger.warn(`Order ${orderId} not found, nothing to do`);
      return;
    }
    if (order.status !== OrderStatus.PENDING) {
      this.logger.log(`Order ${orderId} already ${order.status}, skipping`);
      return;
    }
    await this.processing.recordAttempt(orderId);

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
      this.logger.log(`Order ${orderId}: ${outcome}`);
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
      this.logger.warn(
        `Order ${orderId} attempt ${attempt}/${maxAttempts} failed, will retry: ${describe(error)}`,
      );
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
    this.logger.log(`Order ${orderId}: FAILED (${decision.reason})`);

    if (decision.deadLetter) {
      throw error; // the original job also ends up in BullMQ's failed set
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
