import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { validationPipeProvider } from '../../../../src/common/validation';
import { buildTypeOrmOptions } from '../../../../src/database/typeorm.options';
import { seedProducts } from '../../../../src/database/seeds/products.seed';
import { OrderStatus } from '../../../../src/orders/domain/order-status.enum';
import { OrderResponse } from '../../../../src/orders/dto/order.response';
import { Order } from '../../../../src/database/entities/order.entity';
import { OrdersModule } from '../../../../src/orders/orders.module';
import { OutboxEvent } from '../../../../src/database/entities/outbox-event.entity';
import { OutboxStatus } from '../../../../src/outbox/domain/outbox-status.enum';
import { AuthTestApp, createAuthTestApp } from '../../../support/auth-test-app';
import { testDatabaseEnv, truncate } from '../../../support/database';

describe('POST /orders/:id/reprocess (real guards + MySQL)', () => {
  let t: AuthTestApp;
  let dataSource: DataSource;
  let adminToken: string;
  let userToken: string;

  beforeAll(async () => {
    t = await createAuthTestApp([], {
      imports: [
        TypeOrmModule.forRoot(buildTypeOrmOptions(testDatabaseEnv())),
        OrdersModule,
      ],
      providers: [validationPipeProvider],
    });
    dataSource = t.app.get<DataSource>(getDataSourceToken());
    await truncate(dataSource, 'products');
    await seedProducts(dataSource.manager);
    adminToken = await t.idp.signToken({ roles: ['ADMIN'] });
    userToken = await t.idp.signToken({ roles: ['USER'] });
  });
  afterAll(() => t.close());
  beforeEach(() =>
    truncate(dataSource, 'orders', 'order_items', 'outbox_events'),
  );

  const reprocess = (id: string, token = adminToken) =>
    t.post(`/orders/${id}/reprocess`, {}, token);

  /** An order as the worker leaves it after giving up. */
  const aFailedOrder = async (): Promise<OrderResponse> => {
    const order = (
      await t
        .post(
          '/orders',
          {
            customerName: 'Maria',
            items: [{ productName: 'Mouse', quantity: 1, price: 10 }],
          },
          userToken,
        )
        .expect(201)
    ).body as OrderResponse;
    await dataSource.getRepository(Order).update(order.id, {
      status: OrderStatus.FAILED,
      failureReason: 'falha simulada no processamento',
      processingAttempts: 3,
    });
    await dataSource
      .getRepository(OutboxEvent)
      .update({ aggregateId: order.id }, { status: OutboxStatus.PUBLISHED });
    return order;
  };

  const eventsOf = (orderId: string) =>
    dataSource
      .getRepository(OutboxEvent)
      .find({ where: { aggregateId: orderId }, order: { createdAt: 'ASC' } });

  it('puts a FAILED order back to PENDING with a new order.created event', async () => {
    const order = await aFailedOrder();
    const [original] = await eventsOf(order.id);

    const body = (await reprocess(order.id).expect(202)).body as OrderResponse;

    expect(body).toMatchObject({
      id: order.id,
      status: OrderStatus.PENDING,
      failureReason: null,
      items: order.items,
    });
    expect(
      await dataSource.getRepository(Order).findOneByOrFail({ id: order.id }),
    ).toMatchObject({
      status: OrderStatus.PENDING,
      failureReason: null,
      // History is kept; the new job starts its own attempts.
      processingAttempts: 3,
    });

    const events = await eventsOf(order.id);
    expect(events).toHaveLength(2);
    const requeued = events.find((e) => e.id !== original.id)!;
    expect(requeued).toMatchObject({
      eventType: 'order.created',
      status: OutboxStatus.PENDING,
      correlationId: original.correlationId,
      payload: { orderId: order.id, correlationId: original.correlationId },
    });
  });

  it('requeues once when two admins reprocess at the same time', async () => {
    const order = await aFailedOrder();

    const statuses = await Promise.all([
      reprocess(order.id).then((res) => res.status),
      reprocess(order.id).then((res) => res.status),
    ]);

    expect(statuses.sort()).toEqual([202, 409]);
    expect(await eventsOf(order.id)).toHaveLength(2);
  });

  it.each([OrderStatus.PENDING, OrderStatus.PROCESSED])(
    'refuses a %s order with 409 and writes nothing',
    async (status) => {
      const order = await aFailedOrder();
      await dataSource.getRepository(Order).update(order.id, { status });

      const { body } = (await reprocess(order.id).expect(409)) as {
        body: unknown;
      };

      expect(body).toMatchObject({
        statusCode: 409,
        message: `Only FAILED orders can be reprocessed; order ${order.id} is ${status}`,
      });
      expect(await eventsOf(order.id)).toHaveLength(1);
    },
  );

  it('answers 404 for an unknown order', async () => {
    await reprocess(randomUUID()).expect(404);
  });

  it('rejects an id that is not a UUID with 400', async () => {
    await reprocess('42').expect(400);
  });

  it('forbids USER with 403 and changes nothing', async () => {
    const order = await aFailedOrder();

    await reprocess(order.id, userToken).expect(403);

    expect(
      (await dataSource.getRepository(Order).findOneByOrFail({ id: order.id }))
        .status,
    ).toBe(OrderStatus.FAILED);
  });

  it('requires a token', async () => {
    await t.post(`/orders/${randomUUID()}/reprocess`, {}).expect(401);
  });
});
