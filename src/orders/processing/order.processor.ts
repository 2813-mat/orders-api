import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { setTimeout as sleep } from 'node:timers/promises';
import { EnvironmentVariables } from '../../config/env.validation';
import { InsufficientStockError } from '../domain/errors';
import { OrderStatus } from '../domain/order-status.enum';
import { OrderJobData, ORDERS_QUEUE } from '../queue/queue.constants';
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

    const status = await this.processing.currentStatus(orderId);
    if (status === null) {
      this.logger.warn(`Order ${orderId} not found, nothing to do`);
      return;
    }
    if (status !== OrderStatus.PENDING) {
      this.logger.log(`Order ${orderId} already ${status}, skipping`);
      return;
    }

    // Stands in for slow external work. Outside any transaction on purpose:
    // holding row locks for 1-2s would serialize every order on those rows.
    await sleep(
      simulatedWorkMs(
        this.config.get('PROCESSING_MIN_MS', { infer: true }),
        this.config.get('PROCESSING_MAX_MS', { infer: true }),
      ),
    );

    try {
      const outcome = await this.processing.reserveAndConfirm(orderId);
      this.logger.log(`Order ${orderId}: ${outcome}`);
    } catch (error) {
      if (error instanceof InsufficientStockError) {
        await this.processing.markFailed(orderId, error.message);
        this.logger.log(`Order ${orderId}: FAILED (${error.message})`);
        return; // completed, not failed: a retry wouldn't bring stock back
      }
      throw error;
    }
  }
}
