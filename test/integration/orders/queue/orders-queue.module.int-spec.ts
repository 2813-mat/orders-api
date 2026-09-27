import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { OrdersQueueModule } from '../../../../src/orders/queue/orders-queue.module';
import {
  ORDER_CREATED_JOB,
  ORDER_FAILED_JOB,
  OrderDeadLetterData,
  OrderJobData,
  ORDERS_DEAD_LETTER_QUEUE,
  ORDERS_QUEUE,
} from '../../../../src/orders/queue/queue.constants';
import { testRedisEnv } from '../../../support/redis';

describe('OrdersQueueModule (real Redis)', () => {
  let moduleRef: TestingModule;
  let orders: Queue<OrderJobData>;
  let deadLetter: Queue<OrderDeadLetterData>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              ...testRedisEnv(),
              QUEUE_ATTEMPTS: 3,
              QUEUE_BACKOFF_MS: 1000,
            }),
          ],
        }),
        OrdersQueueModule,
      ],
    }).compile();
    await moduleRef.init();

    orders = moduleRef.get(getQueueToken(ORDERS_QUEUE));
    deadLetter = moduleRef.get(getQueueToken(ORDERS_DEAD_LETTER_QUEUE));
  });

  beforeEach(async () => {
    await Promise.all([
      orders.obliterate({ force: true }),
      deadLetter.obliterate({ force: true }),
    ]);
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  const aJob = (): OrderJobData => ({
    orderId: randomUUID(),
    correlationId: randomUUID(),
  });

  it('applies retry defaults from env to order jobs', async () => {
    const job = await orders.add(ORDER_CREATED_JOB, aJob());

    expect(job.opts).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: 1000,
      removeOnFail: false,
    });
  });

  it('deduplicates a republished event by jobId (outbox event id)', async () => {
    const outboxEventId = randomUUID();
    const first = await orders.add(ORDER_CREATED_JOB, aJob(), {
      jobId: outboxEventId,
    });
    const again = await orders.add(ORDER_CREATED_JOB, aJob(), {
      jobId: outboxEventId,
    });

    expect(again.id).toBe(first.id);
    expect(await orders.getJobCounts('waiting')).toEqual({ waiting: 1 });
    // The second add is a no-op: Redis still holds the first payload.
    const stored = await orders.getJob(outboxEventId);
    expect(stored?.data).toEqual(first.data);
  });

  it('keeps dead-letter jobs without retries', async () => {
    const job = await deadLetter.add(ORDER_FAILED_JOB, {
      ...aJob(),
      reason: 'boom',
      attempts: 3,
      failedAt: new Date().toISOString(),
    });

    expect(job.opts).toMatchObject({
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false,
    });
    expect(await deadLetter.getJobCounts('waiting')).toEqual({ waiting: 1 });
  });
});
