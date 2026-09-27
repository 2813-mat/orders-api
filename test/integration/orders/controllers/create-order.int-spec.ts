import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { validationPipeProvider } from '../../../../src/common/validation';
import { buildTypeOrmOptions } from '../../../../src/database/typeorm.options';
import { seedProducts } from '../../../../src/database/seeds/products.seed';
import { OrderResponse } from '../../../../src/orders/dto/order.response';
import { OrderStatus } from '../../../../src/orders/domain/order-status.enum';
import { OrderItem } from '../../../../src/database/entities/order-item.entity';
import { Order } from '../../../../src/database/entities/order.entity';
import { OrdersModule } from '../../../../src/orders/orders.module';
import { OutboxEvent } from '../../../../src/database/entities/outbox-event.entity';
import { OutboxStatus } from '../../../../src/outbox/domain/outbox-status.enum';
import { Product } from '../../../../src/database/entities/product.entity';
import { AuthTestApp, createAuthTestApp } from '../../../support/auth-test-app';
import { testDatabaseEnv, truncate } from '../../../support/database';

describe('POST /orders (real guards + MySQL)', () => {
  let t: AuthTestApp;
  let dataSource: DataSource;
  let productIds: Map<string, number>;

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
    const products = await dataSource.getRepository(Product).find();
    productIds = new Map(products.map((p) => [p.name, p.id]));
  });
  afterAll(() => t.close());
  beforeEach(() =>
    truncate(dataSource, 'orders', 'order_items', 'outbox_events'),
  );

  const userToken = (sub = randomUUID()) =>
    t.idp.signToken({ sub, roles: ['USER'] });

  const aValidOrder = () => ({
    customerName: 'Maria',
    items: [
      { productName: 'Notebook', quantity: 1, price: 3500.5 },
      { productName: 'Mouse', quantity: 3, price: 0.1 },
    ],
  });

  const countRows = async () => ({
    orders: await dataSource.getRepository(Order).count(),
    items: await dataSource.getRepository(OrderItem).count(),
    events: await dataSource.getRepository(OutboxEvent).count(),
  });
  const nothingWritten = { orders: 0, items: 0, events: 0 };

  it('saves a PENDING order, its items and one order.created event', async () => {
    const sub = randomUUID();

    const body = (
      await t.post('/orders', aValidOrder(), await userToken(sub)).expect(201)
    ).body as OrderResponse;

    expect(body).toMatchObject({
      customerName: 'Maria',
      status: OrderStatus.PENDING,
      total: 3500.8,
      failureReason: null,
      processedAt: null,
      items: [
        {
          productName: 'Notebook',
          quantity: 1,
          price: 3500.5,
          subtotal: 3500.5,
        },
        { productName: 'Mouse', quantity: 3, price: 0.1, subtotal: 0.3 },
      ],
    });
    expect(body).not.toHaveProperty('createdBySub');

    const order = await dataSource.getRepository(Order).findOneOrFail({
      where: { id: body.id },
      relations: { items: true },
      order: { items: { id: 'ASC' } },
    });
    expect(order).toMatchObject({
      status: OrderStatus.PENDING,
      total: 3500.8,
      createdBySub: sub,
      processingAttempts: 0,
    });
    expect(order.items.map((i) => i.productId)).toEqual([
      productIds.get('Notebook'),
      productIds.get('Mouse'),
    ]);

    const events = await dataSource.getRepository(OutboxEvent).find();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'order.created',
      aggregateId: order.id,
      status: OutboxStatus.PENDING,
      correlationId: order.correlationId,
      payload: { orderId: order.id, correlationId: order.correlationId },
    });
  });

  it('matches products case-insensitively and keeps repeated products as separate lines', async () => {
    const body = (
      await t
        .post(
          '/orders',
          {
            customerName: '  Ana  ',
            items: [
              { productName: 'mouse', quantity: 1, price: 10 },
              { productName: 'MOUSE', quantity: 2, price: 10 },
            ],
          },
          await userToken(),
        )
        .expect(201)
    ).body as OrderResponse;

    expect(body.customerName).toBe('Ana');
    expect(body.total).toBe(30);
    expect(body.items).toEqual([
      { productName: 'Mouse', quantity: 1, price: 10, subtotal: 10 },
      { productName: 'Mouse', quantity: 2, price: 10, subtotal: 20 },
    ]);
  });

  it('lets ADMIN create orders too', async () => {
    await t
      .post(
        '/orders',
        aValidOrder(),
        await t.idp.signToken({ roles: ['ADMIN'] }),
      )
      .expect(201);
  });

  it('rejects anonymous requests with 401 and writes nothing', async () => {
    await t.post('/orders', aValidOrder()).expect(401);

    expect(await countRows()).toEqual(nothingWritten);
  });

  it('rejects a token without USER or ADMIN with 403', async () => {
    await t
      .post('/orders', aValidOrder(), await t.idp.signToken({ roles: [] }))
      .expect(403);

    expect(await countRows()).toEqual(nothingWritten);
  });

  const item = { productName: 'Mouse', quantity: 1, price: 10 };
  it.each([
    ['no customerName', { items: [item] }],
    ['blank customerName', { customerName: '   ', items: [item] }],
    [
      'customerName over 120 chars',
      { customerName: 'x'.repeat(121), items: [item] },
    ],
    ['no items', { customerName: 'Maria', items: [] }],
    ['items not an array', { customerName: 'Maria', items: item }],
    [
      'quantity 0',
      { customerName: 'Maria', items: [{ ...item, quantity: 0 }] },
    ],
    [
      'fractional quantity',
      { customerName: 'Maria', items: [{ ...item, quantity: 1.5 }] },
    ],
    [
      'negative price',
      { customerName: 'Maria', items: [{ ...item, price: -1 }] },
    ],
    [
      'price with 3 decimals',
      { customerName: 'Maria', items: [{ ...item, price: 10.005 }] },
    ],
    [
      'price as string',
      { customerName: 'Maria', items: [{ ...item, price: '10' }] },
    ],
    ['unknown field', { customerName: 'Maria', items: [item], total: 1 }],
    [
      'unknown item field',
      { customerName: 'Maria', items: [{ ...item, productId: 1 }] },
    ],
  ])('rejects %s with 400', async (_case, payload) => {
    await t.post('/orders', payload, await userToken()).expect(400);

    expect(await countRows()).toEqual(nothingWritten);
  });

  it('rejects unknown products with 422 and writes nothing', async () => {
    const body = (
      await t
        .post(
          '/orders',
          {
            customerName: 'Maria',
            items: [
              { productName: 'Mouse', quantity: 1, price: 10 },
              { productName: 'Monitor', quantity: 1, price: 10 },
              { productName: 'Cadeira', quantity: 1, price: 10 },
            ],
          },
          await userToken(),
        )
        .expect(422)
    ).body as Record<string, unknown>;

    expect(body).toEqual({
      statusCode: 422,
      error: 'Unprocessable Entity',
      message: 'unknown products: Monitor, Cadeira',
    });
    expect(await countRows()).toEqual(nothingWritten);
  });

  it('rejects a total the database cannot store with 422', async () => {
    await t
      .post(
        '/orders',
        {
          customerName: 'Maria',
          items: [{ productName: 'Mouse', quantity: 1_000, price: 99_999_999 }],
        },
        await userToken(),
      )
      .expect(422, {
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: 'order total is too large',
      });
  });
});
