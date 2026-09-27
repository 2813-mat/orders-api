import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { CORRELATION_ID_HEADER } from '../../../src/common/correlation/correlation-id';
import { LoggingModule } from '../../../src/common/logging/logging.module';
import { validationPipeProvider } from '../../../src/common/validation';
import { buildTypeOrmOptions } from '../../../src/database/typeorm.options';
import { seedProducts } from '../../../src/database/seeds/products.seed';
import { OrderResponse } from '../../../src/orders/dto/order.response';
import { Order } from '../../../src/orders/entities/order.entity';
import { OrdersModule } from '../../../src/orders/orders.module';
import { OutboxEvent } from '../../../src/outbox/outbox-event.entity';
import { AuthTestApp, createAuthTestApp } from '../../support/auth-test-app';
import { testDatabaseEnv, truncate } from '../../support/database';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('Correlation id across the API (real middleware + MySQL)', () => {
  let t: AuthTestApp;
  let dataSource: DataSource;
  let token: string;

  beforeAll(async () => {
    t = await createAuthTestApp([], {
      imports: [
        LoggingModule.forRoot({ http: true }),
        TypeOrmModule.forRoot(buildTypeOrmOptions(testDatabaseEnv())),
        OrdersModule,
      ],
      providers: [validationPipeProvider],
      config: { LOG_LEVEL: 'silent' },
    });
    dataSource = t.app.get<DataSource>(getDataSourceToken());
    await truncate(dataSource, 'products', 'orders', 'order_items');
    await seedProducts(dataSource.manager);
    token = await t.idp.signToken({ roles: ['USER'] });
  });
  afterAll(() => t.close());
  beforeEach(() => truncate(dataSource, 'outbox_events'));

  const createOrder = (correlationId?: string) => {
    const req = t.post(
      '/orders',
      {
        customerName: 'Maria',
        items: [{ productName: 'Mouse', quantity: 1, price: 10 }],
      },
      token,
    );
    return correlationId ? req.set(CORRELATION_ID_HEADER, correlationId) : req;
  };

  /** The id must reach the order row and its outbox event (hence the job). */
  const expectStoredWith = async (orderId: string, correlationId: string) => {
    expect(
      (await dataSource.getRepository(Order).findOneByOrFail({ id: orderId }))
        .correlationId,
    ).toBe(correlationId);
    expect(
      await dataSource
        .getRepository(OutboxEvent)
        .findOneByOrFail({ aggregateId: orderId }),
    ).toMatchObject({
      correlationId,
      payload: { orderId, correlationId },
    });
  };

  it("keeps the caller's id: echoed back and stored with the order and its event", async () => {
    const correlationId = randomUUID();

    const res = await createOrder(correlationId).expect(201);

    expect(res.headers[CORRELATION_ID_HEADER]).toBe(correlationId);
    await expectStoredWith((res.body as OrderResponse).id, correlationId);
  });

  it('generates one when the caller sends none', async () => {
    const res = await createOrder().expect(201);

    const generated = res.headers[CORRELATION_ID_HEADER];
    expect(generated).toMatch(UUID);
    await expectStoredWith((res.body as OrderResponse).id, generated);
  });

  it('replaces an id that is not a UUID instead of storing free text', async () => {
    const res = await createOrder("'; DROP TABLE orders; --").expect(201);

    const generated = res.headers[CORRELATION_ID_HEADER];
    expect(generated).toMatch(UUID);
    await expectStoredWith((res.body as OrderResponse).id, generated);
  });

  it('gives each request its own id', async () => {
    const [a, b] = await Promise.all([createOrder(), createOrder()]);

    expect(a.headers[CORRELATION_ID_HEADER]).not.toBe(
      b.headers[CORRELATION_ID_HEADER],
    );
  });

  it('answers with the id even when the request is rejected', async () => {
    const correlationId = randomUUID();

    const res = await t
      .get('/orders')
      .set(CORRELATION_ID_HEADER, correlationId)
      .expect(401);

    expect(res.headers[CORRELATION_ID_HEADER]).toBe(correlationId);
  });
});
