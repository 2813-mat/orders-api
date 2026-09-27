import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { InsufficientStockError } from '../../../../src/orders/domain/errors';
import { OrderStatus } from '../../../../src/orders/domain/order-status.enum';
import { OrderItem } from '../../../../src/orders/entities/order-item.entity';
import { Order } from '../../../../src/orders/entities/order.entity';
import { StockReservation } from '../../../../src/orders/entities/stock-reservation.entity';
import {
  OrderProcessingService,
  ReservationOutcome,
} from '../../../../src/orders/processing/order-processing.service';
import { Product } from '../../../../src/products/product.entity';
import { createTestDataSource, truncate } from '../../../support/database';

describe('OrderProcessingService (real MySQL, real concurrency)', () => {
  let dataSource: DataSource;
  let service: OrderProcessingService;

  beforeAll(async () => {
    // Pooled connections: parallel calls really run in parallel in MySQL.
    dataSource = await createTestDataSource();
    service = new OrderProcessingService(dataSource);
  });
  afterAll(() => dataSource.destroy());
  beforeEach(() =>
    truncate(
      dataSource,
      'stock_reservations',
      'order_items',
      'orders',
      'products',
    ),
  );

  const createProduct = async (name: string, stock: number) =>
    dataSource.getRepository(Product).save({ name, stock });

  const stockOf = async (product: Product) =>
    (
      await dataSource
        .getRepository(Product)
        .findOneByOrFail({ id: product.id })
    ).stock;

  const createOrder = async (
    ...items: Array<[product: Product, quantity: number]>
  ): Promise<string> => {
    const order = await dataSource.getRepository(Order).save(
      dataSource.getRepository(Order).create({
        customerName: 'Cliente',
        total: 0,
        status: OrderStatus.PENDING,
        createdBySub: randomUUID(),
      }),
    );
    await dataSource.getRepository(OrderItem).save(
      items.map(([product, quantity]) => ({
        orderId: order.id,
        productId: product.id,
        productName: product.name,
        quantity,
        unitPrice: 1,
        subtotal: quantity,
      })),
    );
    return order.id;
  };

  const orderById = (id: string) =>
    dataSource.getRepository(Order).findOneByOrFail({ id });

  const reservationsOf = (orderId: string) =>
    dataSource.getRepository(StockReservation).findBy({ orderId });

  /** What the worker does after its simulated work. */
  const process = async (orderId: string) => {
    try {
      return await service.reserveAndConfirm(orderId);
    } catch (error) {
      if (error instanceof InsufficientStockError) {
        await service.markFailed(orderId, error.message);
        return 'OUT_OF_STOCK' as const;
      }
      throw error;
    }
  };

  const statusCounts = async (orderIds: string[]) => {
    const orders = await Promise.all(orderIds.map(orderById));
    return {
      processed: orders.filter((o) => o.status === OrderStatus.PROCESSED)
        .length,
      failed: orders.filter((o) => o.status === OrderStatus.FAILED).length,
    };
  };

  describe('reservation', () => {
    it('takes the stock, records the reservation and confirms the order', async () => {
      const notebook = await createProduct('Notebook', 5);
      const mouse = await createProduct('Mouse', 5);
      const orderId = await createOrder([notebook, 2], [mouse, 1]);

      await expect(service.reserveAndConfirm(orderId)).resolves.toBe(
        ReservationOutcome.PROCESSED,
      );

      expect(await stockOf(notebook)).toBe(3);
      expect(await stockOf(mouse)).toBe(4);
      const order = await orderById(orderId);
      expect(order.status).toBe(OrderStatus.PROCESSED);
      expect(order.processedAt).toBeInstanceOf(Date);
      expect(
        (await reservationsOf(orderId))
          .map((r) => [r.productId, r.quantity])
          .sort(),
      ).toEqual([
        [notebook.id, 2],
        [mouse.id, 1],
      ]);
    });

    it('sums repeated products into one reservation', async () => {
      const mouse = await createProduct('Mouse', 5);
      const orderId = await createOrder([mouse, 2], [mouse, 2]);

      await service.reserveAndConfirm(orderId);

      expect(await stockOf(mouse)).toBe(1);
      expect(await reservationsOf(orderId)).toEqual([
        expect.objectContaining({ productId: mouse.id, quantity: 4 }),
      ]);
    });

    it('checks repeated products against stock as a whole: 3 + 3 does not fit in 5', async () => {
      const mouse = await createProduct('Mouse', 5);
      const orderId = await createOrder([mouse, 3], [mouse, 3]);

      await expect(process(orderId)).resolves.toBe('OUT_OF_STOCK');

      expect(await stockOf(mouse)).toBe(5);
      expect(await orderById(orderId)).toMatchObject({
        status: OrderStatus.FAILED,
        failureReason: 'estoque insuficiente: Mouse',
      });
    });

    it('rolls back every product when one of them is short (no partial reservation)', async () => {
      const notebook = await createProduct('Notebook', 5);
      const mouse = await createProduct('Mouse', 1);
      // Notebook has the lower id: it is decremented first, then Mouse fails.
      const orderId = await createOrder([notebook, 2], [mouse, 2]);

      await expect(service.reserveAndConfirm(orderId)).rejects.toThrow(
        new InsufficientStockError('Mouse'),
      );

      expect(await stockOf(notebook)).toBe(5);
      expect(await stockOf(mouse)).toBe(1);
      expect(await reservationsOf(orderId)).toEqual([]);
      expect((await orderById(orderId)).status).toBe(OrderStatus.PENDING);
    });

    it('reports an unknown order without touching anything', async () => {
      await expect(service.reserveAndConfirm(randomUUID())).resolves.toBe(
        ReservationOutcome.NOT_FOUND,
      );
    });
  });

  describe('concurrency', () => {
    it('two orders of 3 against a stock of 5: exactly one wins', async () => {
      const mouse = await createProduct('Mouse', 5);
      const a = await createOrder([mouse, 3]);
      const b = await createOrder([mouse, 3]);

      await Promise.all([process(a), process(b)]);

      expect(await statusCounts([a, b])).toEqual({ processed: 1, failed: 1 });
      expect(await stockOf(mouse)).toBe(2);
    });

    it('ten orders of 1 against a stock of 5: five confirmed, five failed, stock 0', async () => {
      const mouse = await createProduct('Mouse', 5);
      const orders = await Promise.all(
        Array.from({ length: 10 }, () => createOrder([mouse, 1])),
      );

      await Promise.all(orders.map(process));

      expect(await statusCounts(orders)).toEqual({ processed: 5, failed: 5 });
      expect(await stockOf(mouse)).toBe(0);
      expect(
        await dataSource.getRepository(StockReservation).countBy({
          productId: mouse.id,
        }),
      ).toBe(5);
    });

    it('orders locking the same products in opposite item order never deadlock', async () => {
      const notebook = await createProduct('Notebook', 1_000);
      const mouse = await createProduct('Mouse', 1_000);

      for (let round = 0; round < 10; round++) {
        const orders = await Promise.all([
          createOrder([notebook, 1], [mouse, 1]),
          createOrder([mouse, 1], [notebook, 1]),
          createOrder([notebook, 1], [mouse, 1]),
          createOrder([mouse, 1], [notebook, 1]),
        ]);
        // Any ER_LOCK_DEADLOCK would reject here.
        await expect(Promise.all(orders.map(process))).resolves.toEqual(
          orders.map(() => ReservationOutcome.PROCESSED),
        );
      }

      expect(await stockOf(notebook)).toBe(960);
      expect(await stockOf(mouse)).toBe(960);
    });
  });

  describe('idempotency', () => {
    it('processing the same order again changes nothing', async () => {
      const mouse = await createProduct('Mouse', 5);
      const orderId = await createOrder([mouse, 2]);

      await expect(service.reserveAndConfirm(orderId)).resolves.toBe(
        ReservationOutcome.PROCESSED,
      );
      await expect(service.reserveAndConfirm(orderId)).resolves.toBe(
        ReservationOutcome.ALREADY_FINAL,
      );

      expect(await stockOf(mouse)).toBe(3);
      expect(await reservationsOf(orderId)).toHaveLength(1);
    });

    it('the same order processed by five workers at once is reserved once', async () => {
      const mouse = await createProduct('Mouse', 5);
      const orderId = await createOrder([mouse, 2]);

      const outcomes = await Promise.all(
        Array.from({ length: 5 }, () => service.reserveAndConfirm(orderId)),
      );

      expect(outcomes.sort()).toEqual([
        ReservationOutcome.ALREADY_FINAL,
        ReservationOutcome.ALREADY_FINAL,
        ReservationOutcome.ALREADY_FINAL,
        ReservationOutcome.ALREADY_FINAL,
        ReservationOutcome.PROCESSED,
      ]);
      expect(await stockOf(mouse)).toBe(3);
      expect(await reservationsOf(orderId)).toHaveLength(1);
    });

    it('a FAILED order is not reserved by a late retry', async () => {
      const mouse = await createProduct('Mouse', 5);
      const orderId = await createOrder([mouse, 1]);
      await service.markFailed(orderId, 'boom');

      await expect(service.reserveAndConfirm(orderId)).resolves.toBe(
        ReservationOutcome.ALREADY_FINAL,
      );
      expect(await stockOf(mouse)).toBe(5);
    });

    it('marking FAILED never overwrites a PROCESSED order', async () => {
      const mouse = await createProduct('Mouse', 5);
      const orderId = await createOrder([mouse, 1]);
      await service.reserveAndConfirm(orderId);

      await expect(service.markFailed(orderId, 'late failure')).resolves.toBe(
        false,
      );
      expect(await orderById(orderId)).toMatchObject({
        status: OrderStatus.PROCESSED,
        failureReason: null,
      });
    });
  });

  describe('database safety nets', () => {
    it('refuses a negative stock even from a raw UPDATE', async () => {
      const mouse = await createProduct('Mouse', 0);

      await expect(
        dataSource.query('UPDATE products SET stock = -1 WHERE id = ?', [
          mouse.id,
        ]),
      ).rejects.toThrow(/out of range|chk_products_stock/i);
      expect(await stockOf(mouse)).toBe(0);
    });

    it('refuses a second reservation of the same product for the same order', async () => {
      const mouse = await createProduct('Mouse', 5);
      const orderId = await createOrder([mouse, 1]);
      await service.reserveAndConfirm(orderId);

      await expect(
        dataSource
          .getRepository(StockReservation)
          .insert({ orderId, productId: mouse.id, quantity: 1 }),
      ).rejects.toThrow(/Duplicate entry/);
    });
  });
});
