import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { DataSource } from 'typeorm';
import { seedProducts } from '../../src/database/seeds/products.seed';
import { OrderStatus } from '../../src/orders/domain/order-status.enum';
import { OrderPage, OrderResponse } from '../../src/orders/dto/order.response';
import { Order } from '../../src/orders/entities/order.entity';
import { StockReservation } from '../../src/orders/entities/stock-reservation.entity';
import {
  OrderDeadLetterData,
  ORDERS_DEAD_LETTER_QUEUE,
  ORDERS_QUEUE,
} from '../../src/orders/queue/queue.constants';
import { OutboxEvent } from '../../src/outbox/outbox-event.entity';
import { Product } from '../../src/products/product.entity';
import { User } from '../../src/users/user.entity';
import { UserType } from '../../src/users/user-type.enum';
import { truncate } from '../support/database';
import { E2eStack, startE2eStack } from '../support/e2e-stack';

const FINAL = [OrderStatus.PROCESSED, OrderStatus.FAILED];

describe('Orders end to end (API + relay + worker, MySQL + Redis)', () => {
  let stack: E2eStack;
  let dataSource: DataSource;
  let userToken: string;
  let adminToken: string;
  const userSub = randomUUID();

  beforeAll(async () => {
    stack = await startE2eStack();
    dataSource = stack.dataSource;
    userToken = await stack.idp.signToken({ sub: userSub, roles: ['USER'] });
    adminToken = await stack.idp.signToken({
      username: 'admin',
      roles: ['ADMIN', 'USER'],
    });
  });
  afterAll(() => stack.stop());

  beforeEach(async () => {
    // Let the previous test's orders finish before wiping the state they use.
    await stack.waitForIdle();
    await Promise.all(
      [ORDERS_QUEUE, ORDERS_DEAD_LETTER_QUEUE].map((name) =>
        stack.worker
          .get<Queue>(getQueueToken(name))
          .obliterate({ force: true }),
      ),
    );
    await truncate(
      dataSource,
      'stock_reservations',
      'order_items',
      'orders',
      'outbox_events',
      'users',
      'products',
    );
    await seedProducts(dataSource.manager);
  });

  const setStock = (name: string, stock: number) =>
    dataSource.getRepository(Product).update({ name }, { stock });
  const stockOf = async (name: string) =>
    (await dataSource.getRepository(Product).findOneByOrFail({ name })).stock;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const postOrder = (
    token: string,
    customerName: string,
    items: Array<[productName: string, quantity: number]>,
  ) =>
    stack
      .http()
      .post('/orders')
      .set(auth(token))
      .send({
        customerName,
        items: items.map(([productName, quantity]) => ({
          productName,
          quantity,
          price: 10,
        })),
      });

  const createOrder = async (
    token: string,
    customerName: string,
    items: Array<[string, number]>,
  ) =>
    (await postOrder(token, customerName, items).expect(201))
      .body as OrderResponse;

  /** Polls the public API, as a client would, until the order is final. */
  const waitUntilFinal = async (id: string, token = userToken) => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const order = (
        await stack.http().get(`/orders/${id}`).set(auth(token)).expect(200)
      ).body as OrderResponse;
      if (FINAL.includes(order.status)) {
        return order;
      }
      if (Date.now() > deadline) {
        throw new Error(`order ${id} still ${order.status}`);
      }
      await sleep(50);
    }
  };

  it('R11 + full flow: POST saves a PENDING order and its event; the relay and the worker take it to PROCESSED', async () => {
    const correlationId = randomUUID();

    const res = await postOrder(userToken, 'Maria', [
      ['Notebook', 1],
      ['Mouse', 2],
    ])
      .set('x-correlation-id', correlationId)
      .expect(201);
    const created = res.body as OrderResponse;

    expect(created).toMatchObject({ status: OrderStatus.PENDING, total: 30 });
    expect(res.headers['x-correlation-id']).toBe(correlationId);
    const row = await dataSource
      .getRepository(Order)
      .findOneByOrFail({ id: created.id });
    expect(row).toMatchObject({ createdBySub: userSub, correlationId });
    expect(
      await dataSource
        .getRepository(OutboxEvent)
        .findOneByOrFail({ aggregateId: created.id }),
    ).toMatchObject({ eventType: 'order.created', correlationId });

    const final = await waitUntilFinal(created.id);

    expect(final.status).toBe(OrderStatus.PROCESSED);
    expect(final.processedAt).not.toBeNull();
    expect(await stockOf('Notebook')).toBe(4);
    expect(await stockOf('Mouse')).toBe(3);
    expect(
      await dataSource
        .getRepository(StockReservation)
        .countBy({ orderId: created.id }),
    ).toBe(2);
    expect(
      await dataSource
        .getRepository(OutboxEvent)
        .findOneByOrFail({ aggregateId: created.id }),
    ).toMatchObject({ status: 'PUBLISHED' });
    // The user met the API for the first time: local profile created.
    expect(
      await dataSource
        .getRepository(User)
        .findOneByOrFail({ keycloakSub: userSub }),
    ).toMatchObject({ type: UserType.USER });
  });

  it('fails an order without enough stock, with the reason', async () => {
    await setStock('Mouse', 1);

    const created = await createOrder(userToken, 'Maria', [['Mouse', 2]]);

    await expect(waitUntilFinal(created.id)).resolves.toMatchObject({
      status: OrderStatus.FAILED,
      failureReason: 'estoque insuficiente: Mouse',
    });
    expect(await stockOf('Mouse')).toBe(1);
  });

  it('confirms only what the stock allows when orders arrive at the same time', async () => {
    await setStock('Teclado', 3);

    const orders = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        createOrder(userToken, `Cliente ${i}`, [['Teclado', 1]]),
      ),
    );
    const finals = await Promise.all(orders.map((o) => waitUntilFinal(o.id)));

    expect(
      finals.filter((o) => o.status === OrderStatus.PROCESSED),
    ).toHaveLength(3);
    expect(finals.filter((o) => o.status === OrderStatus.FAILED)).toHaveLength(
      3,
    );
    expect(await stockOf('Teclado')).toBe(0);
  });

  it('retries a "fail" order, then marks it FAILED and dead-letters it', async () => {
    const created = await createOrder(userToken, 'Cliente fail', [
      ['Mouse', 1],
    ]);

    await expect(waitUntilFinal(created.id)).resolves.toMatchObject({
      status: OrderStatus.FAILED,
      failureReason: 'falha simulada no processamento',
    });
    expect(
      (
        await dataSource
          .getRepository(Order)
          .findOneByOrFail({ id: created.id })
      ).processingAttempts,
    ).toBe(3);
    const deadLetter = stack.worker.get<Queue<OrderDeadLetterData>>(
      getQueueToken(ORDERS_DEAD_LETTER_QUEUE),
    );
    expect((await deadLetter.getJobs(['waiting'])).map((j) => j.data)).toEqual([
      expect.objectContaining({ orderId: created.id, attempts: 3 }),
    ]);
    expect(await stockOf('Mouse')).toBe(5);
  });

  it('lets ADMIN reprocess a FAILED order once the cause is gone', async () => {
    await setStock('Mouse', 0);
    const created = await createOrder(userToken, 'Maria', [['Mouse', 1]]);
    await waitUntilFinal(created.id);
    await setStock('Mouse', 5);

    await stack
      .http()
      .post(`/orders/${created.id}/reprocess`)
      .set(auth(userToken))
      .expect(403);
    await stack
      .http()
      .post(`/orders/${created.id}/reprocess`)
      .set(auth(adminToken))
      .expect(202);

    await expect(waitUntilFinal(created.id)).resolves.toMatchObject({
      status: OrderStatus.PROCESSED,
      failureReason: null,
    });
    expect(await stockOf('Mouse')).toBe(4);
    await stack
      .http()
      .post(`/orders/${created.id}/reprocess`)
      .set(auth(adminToken))
      .expect(409);
  });

  it("keeps each user's orders private and pages through them", async () => {
    const other = await stack.idp.signToken({ roles: ['USER'] });
    await setStock('Notebook', 100);
    const mine: OrderResponse[] = [];
    for (let i = 0; i < 15; i++) {
      mine.push(await createOrder(userToken, `Pedido ${i}`, [['Notebook', 1]]));
    }
    const theirs = await createOrder(other, 'Outro', [['Notebook', 1]]);

    const page2 = (
      await stack
        .http()
        .get('/orders?page=2&limit=10')
        .set(auth(userToken))
        .expect(200)
    ).body as OrderPage;
    expect(page2.data).toHaveLength(5);
    expect(page2.meta).toEqual({
      page: 2,
      limit: 10,
      total: 15,
      totalPages: 2,
    });

    await stack
      .http()
      .get(`/orders/${theirs.id}`)
      .set(auth(userToken))
      .expect(404);
    await stack
      .http()
      .get(`/orders/${theirs.id}`)
      .set(auth(adminToken))
      .expect(200);
    await stack
      .http()
      .get('/orders?limit=1000')
      .set(auth(userToken))
      .expect(400);
    expect(mine).toHaveLength(15);
  });

  it('accepts a service account token and records it as such', async () => {
    const serviceAccount = await stack.idp.signToken({
      username: 'service-account-orders-api',
      roles: ['USER'],
    });

    const created = await createOrder(serviceAccount, 'Integração', [
      ['Mouse', 1],
    ]);

    expect(
      await dataSource
        .getRepository(User)
        .findOneByOrFail({ username: 'service-account-orders-api' }),
    ).toMatchObject({ type: UserType.SERVICE_ACCOUNT });
    await expect(
      waitUntilFinal(created.id, serviceAccount),
    ).resolves.toMatchObject({ status: OrderStatus.PROCESSED });
  });

  it('rejects requests without a valid token', async () => {
    const order = { customerName: 'x', items: [] };
    await stack.http().post('/orders').send(order).expect(401);
    await stack
      .http()
      .post('/orders')
      .set(auth(await stack.idp.signToken({ signWithUntrustedKey: true })))
      .send(order)
      .expect(401);
    await stack
      .http()
      .post('/orders')
      .set(auth(await stack.idp.signToken({ expiresInSeconds: -60 })))
      .send(order)
      .expect(401);
    expect(await dataSource.getRepository(Order).count()).toBe(0);
  });

  it('serves health and API docs without a token', async () => {
    await stack.http().get('/health').expect(200);
    await stack.http().get('/docs/json').expect(200);
  });
});
