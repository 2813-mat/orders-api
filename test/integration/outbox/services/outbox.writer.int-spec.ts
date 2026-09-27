import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildTypeOrmOptions } from '../../../../src/database/typeorm.options';
import { OrderCreatedEvent } from '../../../../src/orders/domain/events/order-created.event';
import { OutboxEvent } from '../../../../src/database/entities/outbox-event.entity';
import { OutboxStatus } from '../../../../src/outbox/domain/outbox-status.enum';
import { OutboxModule } from '../../../../src/outbox/outbox.module';
import { OutboxWriter } from '../../../../src/outbox/services/outbox.writer';
import { testDatabaseEnv, truncate } from '../../../support/database';

describe('OutboxWriter (real MySQL)', () => {
  let moduleRef: TestingModule;
  let writer: OutboxWriter;
  let dataSource: DataSource;
  const events = () => dataSource.getRepository(OutboxEvent);

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(buildTypeOrmOptions(testDatabaseEnv())),
        OutboxModule,
      ],
    }).compile();
    writer = moduleRef.get(OutboxWriter);
    dataSource = moduleRef.get<DataSource>(getDataSourceToken());
  });
  afterAll(() => moduleRef.close());
  beforeEach(() => truncate(dataSource, 'outbox_events'));

  const anEvent = () => new OrderCreatedEvent(randomUUID(), randomUUID());

  it('stores the event as PENDING when the transaction commits', async () => {
    const event = anEvent();

    const written = await dataSource.transaction((manager) =>
      writer.write(manager, event),
    );

    const row = await events().findOneByOrFail({ id: written.id });
    expect(row).toMatchObject({
      aggregateType: 'order',
      aggregateId: event.aggregateId,
      eventType: 'order.created',
      payload: {
        orderId: event.aggregateId,
        correlationId: event.correlationId,
      },
      correlationId: event.correlationId,
      status: OutboxStatus.PENDING,
      attempts: 0,
      lastError: null,
      publishedAt: null,
    });
  });

  it('gives each event its own id (the future BullMQ jobId)', async () => {
    const [first, second] = await dataSource.transaction(async (manager) => [
      await writer.write(manager, anEvent()),
      await writer.write(manager, anEvent()),
    ]);

    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.id).not.toBe(first.id);
  });

  it('disappears with the transaction when it rolls back', async () => {
    const event = anEvent();

    await expect(
      dataSource.transaction(async (manager) => {
        await writer.write(manager, event);
        throw new Error('something after the write failed');
      }),
    ).rejects.toThrow('something after the write failed');

    expect(await events().count()).toBe(0);
  });

  it('refuses to write outside a transaction', async () => {
    await expect(writer.write(dataSource.manager, anEvent())).rejects.toThrow(
      'OutboxWriter.write must run inside a transaction',
    );

    expect(await events().count()).toBe(0);
  });
});
