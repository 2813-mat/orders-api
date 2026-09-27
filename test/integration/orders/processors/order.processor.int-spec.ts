import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { DataSource } from 'typeorm';
import { buildTypeOrmOptions } from '../../../../src/database/typeorm.options';
import { OrderStatus } from '../../../../src/orders/domain/order-status.enum';
import { OrderItem } from '../../../../src/database/entities/order-item.entity';
import { Order } from '../../../../src/database/entities/order.entity';
import { OrderProcessingModule } from '../../../../src/orders/order-processing.module';
import {
  ORDER_CREATED_JOB,
  ORDER_FAILED_JOB,
  OrderJobData,
  OrderDeadLetterData,
  ORDERS_DEAD_LETTER_QUEUE,
  ORDERS_QUEUE,
} from '../../../../src/orders/queue/queue.constants';
import { Product } from '../../../../src/database/entities/product.entity';
import { testDatabaseEnv, truncate } from '../../../support/database';
import { testRedisEnv } from '../../../support/redis';

describe('OrderProcessor (real BullMQ worker + MySQL)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let queue: Queue<OrderJobData>;
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
              QUEUE_BACKOFF_MS: 100,
              WORKER_CONCURRENCY: 5,
              PROCESSING_MIN_MS: 10,
              PROCESSING_MAX_MS: 50,
            }),
          ],
        }),
        TypeOrmModule.forRoot(buildTypeOrmOptions(testDatabaseEnv())),
        OrderProcessingModule,
      ],
    }).compile();
    await moduleRef.init();
    dataSource = moduleRef.get<DataSource>(getDataSourceToken());
    queue = moduleRef.get(getQueueToken(ORDERS_QUEUE));
    deadLetter = moduleRef.get(getQueueToken(ORDERS_DEAD_LETTER_QUEUE));
  });
  afterAll(() => moduleRef.close());
  beforeEach(async () => {
    await queue.obliterate({ force: true });
    await deadLetter.obliterate({ force: true });
    await truncate(
      dataSource,
      'stock_reservations',
      'order_items',
      'orders',
      'products',
    );
  });

  const createProduct = (name: string, stock: number) =>
    dataSource.getRepository(Product).save({ name, stock });

  const createOrder = async (
    product: Product,
    quantity: number,
    customerName = 'Cliente',
  ) => {
    const order = await dataSource.getRepository(Order).save(
      dataSource.getRepository(Order).create({
        customerName,
        total: quantity,
        status: OrderStatus.PENDING,
        createdBySub: randomUUID(),
      }),
    );
    await dataSource.getRepository(OrderItem).save({
      orderId: order.id,
      productId: product.id,
      productName: product.name,
      quantity,
      unitPrice: 1,
      subtotal: quantity,
    });
    return order.id;
  };

  const enqueue = (orderId: string, jobId = randomUUID()) =>
    queue.add(
      ORDER_CREATED_JOB,
      { orderId, correlationId: randomUUID() },
      { jobId },
    );

  const waitForJob = async (jobId: string) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const state = await queue.getJobState(jobId);
      if (state === 'completed' || state === 'failed') {
        return state;
      }
      await sleep(25);
    }
    throw new Error(`job ${jobId} did not finish in time`);
  };

  const orderById = (id: string) =>
    dataSource.getRepository(Order).findOneByOrFail({ id });

  it('turns a PENDING order into PROCESSED', async () => {
    const mouse = await createProduct('Mouse', 5);
    const orderId = await createOrder(mouse, 2);

    const job = await enqueue(orderId);

    await expect(waitForJob(job.id!)).resolves.toBe('completed');
    expect((await orderById(orderId)).status).toBe(OrderStatus.PROCESSED);
    expect(
      (
        await dataSource
          .getRepository(Product)
          .findOneByOrFail({ id: mouse.id })
      ).stock,
    ).toBe(3);
  });

  it('fails an order without stock once, with the reason, and does not retry', async () => {
    const mouse = await createProduct('Mouse', 1);
    const orderId = await createOrder(mouse, 2);

    const job = await enqueue(orderId);

    await expect(waitForJob(job.id!)).resolves.toBe('completed');
    expect(await orderById(orderId)).toMatchObject({
      status: OrderStatus.FAILED,
      failureReason: 'estoque insuficiente: Mouse',
    });
    expect((await queue.getJob(job.id!))?.attemptsMade).toBe(1);
  });

  it('confirms only what the stock allows when many orders arrive together', async () => {
    const mouse = await createProduct('Mouse', 5);
    const orders = await Promise.all(
      Array.from({ length: 8 }, () => createOrder(mouse, 1)),
    );

    const jobs = await Promise.all(orders.map((id) => enqueue(id)));
    await Promise.all(jobs.map((job) => waitForJob(job.id!)));

    const finals = await Promise.all(orders.map(orderById));
    expect(
      finals.filter((o) => o.status === OrderStatus.PROCESSED),
    ).toHaveLength(5);
    // Failed by the stock check itself, not by the database refusing a
    // negative stock (which would also end FAILED, after retries).
    expect(
      finals
        .filter((o) => o.status === OrderStatus.FAILED)
        .map((o) => [o.failureReason, o.processingAttempts]),
    ).toEqual([
      ['estoque insuficiente: Mouse', 1],
      ['estoque insuficiente: Mouse', 1],
      ['estoque insuficiente: Mouse', 1],
    ]);
    expect(
      (
        await dataSource
          .getRepository(Product)
          .findOneByOrFail({ id: mouse.id })
      ).stock,
    ).toBe(0);
  });

  it('ignores a duplicate job for an order that is already final', async () => {
    const mouse = await createProduct('Mouse', 5);
    const orderId = await createOrder(mouse, 2);
    await waitForJob((await enqueue(orderId)).id!);

    // A second job for the same order (e.g. an event republished after its
    // original job was already removed from Redis).
    const duplicate = await enqueue(orderId);

    await expect(waitForJob(duplicate.id!)).resolves.toBe('completed');
    expect(
      (
        await dataSource
          .getRepository(Product)
          .findOneByOrFail({ id: mouse.id })
      ).stock,
    ).toBe(3);
  });

  it('retries a failing order with backoff, then marks it FAILED and dead-letters it', async () => {
    const mouse = await createProduct('Mouse', 5);
    const orderId = await createOrder(mouse, 1, 'Cliente fail');

    const job = await enqueue(orderId);

    await expect(waitForJob(job.id!)).resolves.toBe('failed');
    expect((await queue.getJob(job.id!))?.attemptsMade).toBe(3);
    expect(await orderById(orderId)).toMatchObject({
      status: OrderStatus.FAILED,
      failureReason: 'falha simulada no processamento',
      processingAttempts: 3,
    });
    // Nothing was reserved on any of the attempts.
    expect(
      (
        await dataSource
          .getRepository(Product)
          .findOneByOrFail({ id: mouse.id })
      ).stock,
    ).toBe(5);

    const [dead] = await deadLetter.getJobs(['waiting']);
    expect(dead.name).toBe(ORDER_FAILED_JOB);
    expect(dead.id).toBe(`${orderId}-${job.id}`);
    expect(dead.data).toMatchObject({
      orderId,
      correlationId: job.data.correlationId,
      reason: 'falha simulada no processamento',
      attempts: 3,
    });
  });

  it('counts a single attempt for an order that goes through', async () => {
    const mouse = await createProduct('Mouse', 5);
    const orderId = await createOrder(mouse, 1);

    await waitForJob((await enqueue(orderId)).id!);

    expect((await orderById(orderId)).processingAttempts).toBe(1);
    expect(await deadLetter.count()).toBe(0);
  });

  it('does not dead-letter a business failure', async () => {
    const mouse = await createProduct('Mouse', 0);
    const orderId = await createOrder(mouse, 1);

    await waitForJob((await enqueue(orderId)).id!);

    expect((await orderById(orderId)).processingAttempts).toBe(1);
    expect(await deadLetter.count()).toBe(0);
  });

  it('completes a job whose order does not exist', async () => {
    const job = await enqueue(randomUUID());

    await expect(waitForJob(job.id!)).resolves.toBe('completed');
  });
});
