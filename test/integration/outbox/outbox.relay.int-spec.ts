import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildTypeOrmOptions } from '../../../src/database/typeorm.options';
import { ORDERS_QUEUE } from '../../../src/orders/queue/queue.constants';
import { OutboxEvent } from '../../../src/database/entities/outbox-event.entity';
import { OutboxStatus } from '../../../src/outbox/outbox-status.enum';
import { OutboxRelayModule } from '../../../src/outbox/outbox-relay.module';
import { OutboxRelay } from '../../../src/outbox/outbox.relay';
import { testDatabaseEnv, truncate } from '../../support/database';
import { testRedisEnv } from '../../support/redis';

/** Nothing listens here: the "Redis is down" relay. */
const UNREACHABLE_REDIS_PORT = 1;

async function bootRelay(config: Record<string, unknown> = {}) {
  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [
          () => ({
            ...testRedisEnv(),
            QUEUE_ATTEMPTS: 3,
            QUEUE_BACKOFF_MS: 1000,
            OUTBOX_BATCH_SIZE: 50,
            OUTBOX_MAX_ATTEMPTS: 10,
            OUTBOX_PUBLISH_TIMEOUT_MS: 300,
            OUTBOX_POLL_INTERVAL_MS: 50,
            ...config,
          }),
        ],
      }),
      TypeOrmModule.forRoot(buildTypeOrmOptions(testDatabaseEnv())),
      OutboxRelayModule,
    ],
  }).compile();
  return {
    moduleRef,
    relay: moduleRef.get(OutboxRelay),
    queue: moduleRef.get<Queue>(getQueueToken(ORDERS_QUEUE)),
    dataSource: moduleRef.get<DataSource>(getDataSourceToken()),
  };
}

describe('OutboxRelay (real MySQL + Redis)', () => {
  let ctx: Awaited<ReturnType<typeof bootRelay>>;
  const events = () => ctx.dataSource.getRepository(OutboxEvent);

  beforeAll(async () => {
    ctx = await bootRelay();
  });
  afterAll(() => ctx.moduleRef.close());
  beforeEach(async () => {
    await truncate(ctx.dataSource, 'outbox_events');
    await ctx.queue.obliterate({ force: true });
  });

  const insertEvents = async (
    count: number,
    overrides: Partial<OutboxEvent> = {},
  ): Promise<OutboxEvent[]> => {
    const saved: OutboxEvent[] = [];
    for (let i = 0; i < count; i++) {
      const orderId = randomUUID();
      const correlationId = randomUUID();
      saved.push(
        await events().save(
          events().create({
            aggregateType: 'order',
            aggregateId: orderId,
            eventType: 'order.created',
            payload: { orderId, correlationId },
            correlationId,
            ...overrides,
          }),
        ),
      );
    }
    return saved;
  };

  it('publishes pending events as jobs keyed by the event id and marks them PUBLISHED', async () => {
    const [first, second] = await insertEvents(2);

    await expect(ctx.relay.publishBatch()).resolves.toEqual({
      published: 2,
      interrupted: false,
      full: false,
    });

    for (const event of [first, second]) {
      const job = await ctx.queue.getJob(event.id);
      expect(job?.name).toBe('order.created');
      expect(job?.data).toEqual(event.payload);

      const row = await events().findOneByOrFail({ id: event.id });
      expect(row.status).toBe(OutboxStatus.PUBLISHED);
      expect(row.publishedAt).toBeInstanceOf(Date);
    }
  });

  it('leaves PUBLISHED and FAILED events alone', async () => {
    await insertEvents(1, { status: OutboxStatus.PUBLISHED });
    await insertEvents(1, { status: OutboxStatus.FAILED });

    await expect(ctx.relay.publishBatch()).resolves.toMatchObject({
      published: 0,
    });
    expect(await ctx.queue.count()).toBe(0);
  });

  it('does not duplicate the job when an event is published twice (crash before commit)', async () => {
    const [event] = await insertEvents(1);
    await ctx.relay.publishBatch();
    // As if the relay had died after publishing, before its commit.
    await events().update(event.id, {
      status: OutboxStatus.PENDING,
      publishedAt: null,
    });

    await expect(ctx.relay.publishBatch()).resolves.toMatchObject({
      published: 1,
    });

    expect(await ctx.queue.count()).toBe(1);
  });

  it('reports a full batch so the loop drains the backlog without waiting', async () => {
    const small = await bootRelay({ OUTBOX_BATCH_SIZE: 2 });
    try {
      await insertEvents(3);

      await expect(small.relay.publishBatch()).resolves.toEqual({
        published: 2,
        interrupted: false,
        full: true,
      });
      await expect(small.relay.publishBatch()).resolves.toEqual({
        published: 1,
        interrupted: false,
        full: false,
      });
    } finally {
      await small.moduleRef.close();
    }
  });

  it('fails an event with no route right away and keeps publishing the rest', async () => {
    const [unroutable] = await insertEvents(1, { eventType: 'order.unknown' });
    const [routable] = await insertEvents(1);

    await expect(ctx.relay.publishBatch()).resolves.toMatchObject({
      published: 1,
      interrupted: false,
    });

    expect(await events().findOneByOrFail({ id: unroutable.id })).toMatchObject(
      {
        status: OutboxStatus.FAILED,
        attempts: 1,
        lastError: 'no queue for event type order.unknown',
      },
    );
    expect((await events().findOneByOrFail({ id: routable.id })).status).toBe(
      OutboxStatus.PUBLISHED,
    );
  });

  describe('with Redis unreachable', () => {
    let broken: Awaited<ReturnType<typeof bootRelay>>;

    beforeAll(async () => {
      broken = await bootRelay({
        REDIS_PORT: UNREACHABLE_REDIS_PORT,
        OUTBOX_MAX_ATTEMPTS: 2,
      });
    });
    afterAll(() => broken.moduleRef.close());

    it('keeps the event PENDING, records the attempt and stops the batch; publishes once Redis is back', async () => {
      await insertEvents(3);

      await expect(broken.relay.publishBatch()).resolves.toEqual({
        published: 0,
        interrupted: true,
        full: false,
      });

      const rows = await events().find({ order: { attempts: 'DESC' } });
      expect(rows.map((r) => r.status)).toEqual([
        OutboxStatus.PENDING,
        OutboxStatus.PENDING,
        OutboxStatus.PENDING,
      ]);
      // Only the first event was tried: the others keep all their attempts.
      expect(rows.map((r) => r.attempts)).toEqual([1, 0, 0]);
      expect(rows[0].lastError).toBe('publish timed out after 300ms');

      // Redis is back (the healthy relay): everything goes out.
      await expect(ctx.relay.publishBatch()).resolves.toMatchObject({
        published: 3,
      });
      expect(await ctx.queue.count()).toBe(3);
    });

    it('gives up after OUTBOX_MAX_ATTEMPTS', async () => {
      const [event] = await insertEvents(1);

      await broken.relay.publishBatch();
      await broken.relay.publishBatch();

      expect(await events().findOneByOrFail({ id: event.id })).toMatchObject({
        status: OutboxStatus.FAILED,
        attempts: 2,
        lastError: 'publish timed out after 300ms',
      });
      await expect(broken.relay.publishBatch()).resolves.toMatchObject({
        published: 0,
        interrupted: false,
      });
    });
  });

  it('two relays running side by side publish each event exactly once (SKIP LOCKED)', async () => {
    const other = await bootRelay({ OUTBOX_BATCH_SIZE: 10 });
    const small = await bootRelay({ OUTBOX_BATCH_SIZE: 10 });
    try {
      await insertEvents(100);
      const addsA = jest.spyOn(small.queue, 'add');
      const addsB = jest.spyOn(other.queue, 'add');

      const drain = async (relay: OutboxRelay) => {
        while ((await relay.publishBatch()).published > 0) {
          // keep going until nothing is left for this instance
        }
      };
      await Promise.all([drain(small.relay), drain(other.relay)]);

      // Not "100 jobs in the queue" (jobId dedupe would hide duplicates):
      // 100 publish calls in total across both instances.
      expect(addsA.mock.calls.length + addsB.mock.calls.length).toBe(100);
      expect(addsA).toHaveBeenCalled();
      expect(addsB).toHaveBeenCalled();
      expect(await events().countBy({ status: OutboxStatus.PUBLISHED })).toBe(
        100,
      );
    } finally {
      await Promise.all([other.moduleRef.close(), small.moduleRef.close()]);
    }
  });

  describe('backlog', () => {
    it('is empty when everything was published', async () => {
      await insertEvents(2, { status: OutboxStatus.PUBLISHED });

      await expect(ctx.relay.backlog()).resolves.toEqual({
        pending: 0,
        failed: 0,
        oldestPendingAgeMs: null,
      });
    });

    it('counts pending and failed events and ages the oldest pending one', async () => {
      const [oldest] = await insertEvents(2);
      await insertEvents(1, { status: OutboxStatus.FAILED });
      await insertEvents(1, { status: OutboxStatus.PUBLISHED });
      await ctx.dataSource.query(
        'UPDATE outbox_events SET created_at = NOW(3) - INTERVAL 5 MINUTE WHERE id = ?',
        [oldest.id],
      );

      const backlog = await ctx.relay.backlog();

      expect(backlog).toMatchObject({ pending: 2, failed: 1 });
      expect(backlog.oldestPendingAgeMs).toBeGreaterThanOrEqual(300_000);
      expect(backlog.oldestPendingAgeMs).toBeLessThan(310_000);
    });
  });

  it('polls on its own once started and stops on shutdown', async () => {
    const running = await bootRelay();
    running.relay.start();
    const [event] = await insertEvents(1);

    const deadline = Date.now() + 5_000;
    let status = OutboxStatus.PENDING;
    while (status !== OutboxStatus.PUBLISHED && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = (await events().findOneByOrFail({ id: event.id })).status;
    }
    expect(status).toBe(OutboxStatus.PUBLISHED);

    await running.moduleRef.close();
    const [late] = await insertEvents(1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await events().findOneByOrFail({ id: late.id })).status).toBe(
      OutboxStatus.PENDING,
    );
  });
});
