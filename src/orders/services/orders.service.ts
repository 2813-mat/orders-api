import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { Role } from '../../auth/role.enum';
import { currentCorrelationId } from '../../common/correlation/correlation-id';
import { buildPageMeta, Page, PageRequest } from '../../common/pagination/page';
import { Order } from '../../database/entities/order.entity';
import { Product } from '../../database/entities/product.entity';
import { TransactionRunner } from '../../database/transaction-runner';
import { OutboxWriter } from '../../outbox/services/outbox.writer';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { UnknownProductsError } from '../domain/errors';
import { OrderCreatedEvent } from '../domain/events/order-created.event';
import { OrderStatus } from '../domain/order-status.enum';
import { calculateOrderTotals } from '../domain/order-total';
import { CreateOrderDto } from '../dto/create-order.dto';
import { OrdersRepository } from '../repositories/orders.repository';

export type ReprocessResult =
  | { outcome: 'REQUEUED'; order: Order }
  | { outcome: 'NOT_FAILED'; status: OrderStatus }
  | { outcome: 'NOT_FOUND' };

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly transactions: TransactionRunner,
    private readonly orders: OrdersRepository,
    private readonly products: ProductsRepository,
    private readonly outboxWriter: OutboxWriter,
  ) {}

  /**
   * Saves the order as PENDING and its `order.created` event in one
   * transaction: both exist or neither does. Never touches the queue (the
   * outbox relay publishes) and never checks stock (the worker reserves it).
   */
  async create(input: CreateOrderDto, user: AuthenticatedUser): Promise<Order> {
    const catalog = await this.findProducts(
      input.items.map((item) => item.productName),
    );
    const { subtotals, total } = calculateOrderTotals(
      input.items.map((item) => ({
        quantity: item.quantity,
        unitPrice: item.price,
      })),
    );
    // The request's id (header or generated), so the order, its outbox event,
    // the job and the worker's logs all share it. Outside a request (tests,
    // scripts) there is none: start a new one.
    const correlationId = currentCorrelationId() ?? randomUUID();

    const order = await this.transactions.run(async (tx) => {
      // Items are stored as sent (a repeated product stays two lines); they
      // are only aggregated per product when stock is reserved.
      const order = await this.orders.insertWithItems(
        tx,
        {
          customerName: input.customerName,
          total,
          createdBySub: user.sub,
          correlationId,
        },
        input.items.map((item, index) => {
          const product = catalog.get(item.productName.toLowerCase())!;
          return {
            productId: product.id,
            productName: product.name,
            quantity: item.quantity,
            unitPrice: item.price,
            subtotal: subtotals[index],
          };
        }),
      );
      await this.outboxWriter.write(
        tx,
        new OrderCreatedEvent(order.id, correlationId),
      );
      return order;
    });

    this.logger.log({
      event: 'order.created',
      orderId: order.id,
      total: order.total,
      items: order.items.length,
      createdBySub: user.sub,
      msg: `Order ${order.id} created (PENDING)`,
    });
    return order;
  }

  /**
   * `null` both when the order doesn't exist and when it belongs to someone
   * else: a USER can't tell another user's order id from a made-up one.
   */
  findOne(id: string, user: AuthenticatedUser): Promise<Order | null> {
    return this.orders.findWithItems(id, this.ownerFilter(user));
  }

  async list(
    request: PageRequest,
    user: AuthenticatedUser,
  ): Promise<Page<Order>> {
    const [orders, total] = await this.orders.findPage(
      request,
      this.ownerFilter(user),
    );
    return { data: orders, meta: buildPageMeta(request, total) };
  }

  /**
   * Puts a FAILED order back to PENDING and records a new `order.created`
   * event, in one transaction. The UPDATE only matches a FAILED row, so two
   * simultaneous calls requeue once: the second waits for the row lock, then
   * matches nothing. The new event has a new id, hence a new jobId that does
   * not collide with the old job still in BullMQ's failed set. Safe for stock:
   * a FAILED order never holds a reservation (its transaction rolled back).
   */
  async reprocess(id: string): Promise<ReprocessResult> {
    return this.transactions.run(async (tx) => {
      if (!(await this.orders.requeueIfFailed(tx, id))) {
        const current = await this.orders.findStatus(id, tx);
        return current
          ? { outcome: 'NOT_FAILED', status: current.status }
          : { outcome: 'NOT_FOUND' };
      }

      const order = (await this.orders.findWithItems(id, undefined, tx))!;
      // Same correlation id as the original request: the whole life of the
      // order stays traceable under one id.
      await this.outboxWriter.write(
        tx,
        new OrderCreatedEvent(order.id, order.correlationId ?? randomUUID()),
      );
      return { outcome: 'REQUEUED', order };
    });
  }

  /** ADMIN sees every order; anyone else only the ones they created. */
  private ownerFilter(user: AuthenticatedUser): string | undefined {
    return user.roles.includes(Role.ADMIN) ? undefined : user.sub;
  }

  /**
   * Catalog keyed by lower-cased name, matching MySQL's case-insensitive
   * collation. Unknown names reject the whole order.
   */
  private async findProducts(names: string[]): Promise<Map<string, Product>> {
    const found = await this.products.findByNames(names);
    const catalog = new Map(found.map((p) => [p.name.toLowerCase(), p]));

    const unknown = [...new Set(names)].filter(
      (name) => !catalog.has(name.toLowerCase()),
    );
    if (unknown.length > 0) {
      throw new UnknownProductsError(unknown);
    }
    return catalog;
  }
}
