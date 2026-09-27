import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Page } from '../../../src/common/pagination/page';
import { validationPipeProvider } from '../../../src/common/validation';
import { buildTypeOrmOptions } from '../../../src/database/typeorm.options';
import { seedProducts } from '../../../src/database/seeds/products.seed';
import { OrderStatus } from '../../../src/orders/domain/order-status.enum';
import { OrderResponse } from '../../../src/orders/dto/order.response';
import { OrdersModule } from '../../../src/orders/orders.module';
import { AuthTestApp, createAuthTestApp } from '../../support/auth-test-app';
import { testDatabaseEnv, truncate } from '../../support/database';

describe('GET /orders and /orders/:id (real guards + MySQL)', () => {
  let t: AuthTestApp;
  let dataSource: DataSource;

  const alice = randomUUID();
  const bob = randomUUID();
  let aliceToken: string;
  let bobToken: string;
  let adminToken: string;

  /** Oldest first, as created; bob's order sits between alice's. */
  let aliceOrders: OrderResponse[];
  let bobOrder: OrderResponse;

  const createOrder = async (customerName: string, token: string) =>
    (
      await t
        .post(
          '/orders',
          {
            customerName,
            items: [
              { productName: 'Notebook', quantity: 1, price: 100 },
              { productName: 'Mouse', quantity: 2, price: 5.5 },
            ],
          },
          token,
        )
        .expect(201)
    ).body as OrderResponse;

  beforeAll(async () => {
    t = await createAuthTestApp([], {
      imports: [
        TypeOrmModule.forRoot(buildTypeOrmOptions(testDatabaseEnv())),
        OrdersModule,
      ],
      providers: [validationPipeProvider],
    });
    dataSource = t.app.get<DataSource>(getDataSourceToken());
    await truncate(dataSource, 'products', 'orders', 'order_items');
    await seedProducts(dataSource.manager);

    aliceToken = await t.idp.signToken({ sub: alice, roles: ['USER'] });
    bobToken = await t.idp.signToken({ sub: bob, roles: ['USER'] });
    adminToken = await t.idp.signToken({ roles: ['ADMIN'] });

    const a1 = await createOrder('Alice 1', aliceToken);
    const a2 = await createOrder('Alice 2', aliceToken);
    bobOrder = await createOrder('Bob 1', bobToken);
    const a3 = await createOrder('Alice 3', aliceToken);
    aliceOrders = [a1, a2, a3];

    // Orders created in the same millisecond would tie on created_at:
    // spread them one minute apart, in creation order.
    const inOrder = [a1, a2, bobOrder, a3];
    for (const [index, order] of inOrder.entries()) {
      await dataSource.query('UPDATE orders SET created_at = ? WHERE id = ?', [
        new Date(Date.UTC(2026, 0, 1, 12, index)),
        order.id,
      ]);
    }
  });
  afterAll(() => t.close());

  const list = async (query: string, token: string) =>
    (await t.get(`/orders${query}`, token).expect(200))
      .body as Page<OrderResponse>;
  const names = (page: Page<OrderResponse>) =>
    page.data.map((order) => order.customerName);

  describe('GET /orders/:id', () => {
    it('returns the owner their order with items and current status', async () => {
      const [order] = aliceOrders;

      const body = (await t.get(`/orders/${order.id}`, aliceToken).expect(200))
        .body as OrderResponse;

      expect(body).toEqual({
        ...order,
        createdAt: '2026-01-01T12:00:00.000Z',
      });
      expect(body).toMatchObject({
        status: OrderStatus.PENDING,
        failureReason: null,
        total: 111,
        items: [
          { productName: 'Notebook', quantity: 1, price: 100, subtotal: 100 },
          { productName: 'Mouse', quantity: 2, price: 5.5, subtotal: 11 },
        ],
      });
    });

    it("answers 404 for another user's order, same as for a missing one", async () => {
      const notYours = await t
        .get(`/orders/${bobOrder.id}`, aliceToken)
        .expect(404);
      const missing = await t
        .get(`/orders/${randomUUID()}`, aliceToken)
        .expect(404);

      expect(notYours.body).toMatchObject({ statusCode: 404 });
      expect(Object.keys(notYours.body as object)).toEqual(
        Object.keys(missing.body as object),
      );
    });

    it('lets ADMIN read any order', async () => {
      await t
        .get(`/orders/${bobOrder.id}`, adminToken)
        .expect(200)
        .expect(({ body }) =>
          expect((body as OrderResponse).customerName).toBe('Bob 1'),
        );
    });

    it('rejects an id that is not a UUID with 400', async () => {
      await t.get('/orders/42', aliceToken).expect(400);
    });

    it('requires a token', async () => {
      await t.get(`/orders/${bobOrder.id}`).expect(401);
    });
  });

  describe('GET /orders', () => {
    it('lists only the caller’s orders, newest first, with default paging', async () => {
      const page = await list('', aliceToken);

      expect(names(page)).toEqual(['Alice 3', 'Alice 2', 'Alice 1']);
      expect(page.meta).toEqual({
        page: 1,
        limit: 10,
        total: 3,
        totalPages: 1,
      });
      expect(page.data[0].items).toHaveLength(2);
    });

    it('lists every order for ADMIN', async () => {
      const page = await list('', adminToken);

      expect(names(page)).toEqual(['Alice 3', 'Bob 1', 'Alice 2', 'Alice 1']);
      expect(page.meta.total).toBe(4);
    });

    it('pages through the results', async () => {
      const first = await list('?page=1&limit=2', aliceToken);
      const second = await list('?page=2&limit=2', aliceToken);

      expect(names(first)).toEqual(['Alice 3', 'Alice 2']);
      expect(names(second)).toEqual(['Alice 1']);
      expect(second.meta).toEqual({
        page: 2,
        limit: 2,
        total: 3,
        totalPages: 2,
      });
      // Each order carries its own items, not its neighbours'.
      expect(second.data[0].items).toHaveLength(2);
    });

    it('returns an empty page past the last one', async () => {
      const page = await list('?page=5&limit=2', aliceToken);

      expect(page.data).toEqual([]);
      expect(page.meta).toEqual({ page: 5, limit: 2, total: 3, totalPages: 2 });
    });

    it('returns an empty list to a user without orders', async () => {
      const stranger = await t.idp.signToken({ roles: ['USER'] });

      const page = await list('', stranger);

      expect(page).toEqual({
        data: [],
        meta: { page: 1, limit: 10, total: 0, totalPages: 0 },
      });
    });

    it.each([
      ['page=0'],
      ['page=-1'],
      ['page=abc'],
      ['page=1.5'],
      ['limit=0'],
      ['limit=101'],
      ['sort=createdAt'],
    ])('rejects ?%s with 400', async (query) => {
      await t.get(`/orders?${query}`, aliceToken).expect(400);
    });

    it('requires a token', async () => {
      await t.get('/orders').expect(401);
    });

    it('forbids a token without USER or ADMIN', async () => {
      await t.get('/orders', await t.idp.signToken({ roles: [] })).expect(403);
    });
  });
});
