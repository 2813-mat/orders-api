import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvironmentVariables } from '../../config/env.validation';
import { ORDERS_DEAD_LETTER_QUEUE, ORDERS_QUEUE } from './queue.constants';
import {
  buildOrdersJobOptions,
  buildQueueConnection,
  DEAD_LETTER_JOB_OPTIONS,
} from './queue.options';

type Config = ConfigService<EnvironmentVariables, true>;

/**
 * Redis connection plus the `orders` and `orders-dlq` queues. Imported by the
 * processes that talk to the queue (relay publishes, worker consumes); the HTTP
 * API never does.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: Config) => ({
        connection: buildQueueConnection({
          REDIS_HOST: config.get('REDIS_HOST', { infer: true }),
          REDIS_PORT: config.get('REDIS_PORT', { infer: true }),
        }),
      }),
    }),
    BullModule.registerQueueAsync(
      {
        name: ORDERS_QUEUE,
        inject: [ConfigService],
        useFactory: (config: Config) => ({
          defaultJobOptions: buildOrdersJobOptions({
            QUEUE_ATTEMPTS: config.get('QUEUE_ATTEMPTS', { infer: true }),
            QUEUE_BACKOFF_MS: config.get('QUEUE_BACKOFF_MS', { infer: true }),
          }),
        }),
      },
      {
        name: ORDERS_DEAD_LETTER_QUEUE,
        useFactory: () => ({ defaultJobOptions: DEAD_LETTER_JOB_OPTIONS }),
      },
    ),
  ],
  exports: [BullModule],
})
export class OrdersQueueModule {}
