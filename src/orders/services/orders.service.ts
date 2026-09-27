import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, FindOptionsWhere, In, Repository } from 'typeorm';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { Role } from '../../auth/role.enum';
import {
  buildPageMeta,
  Page,
  PageRequest,
  pageOffset,
} from '../../common/pagination/page';
import { currentCorrelationId } from '../../common/correlation/correlation-id';
import { OutboxWriter } from '../../outbox/services/outbox.writer';
import { Product } from '../../database/entities/product.entity';
import { UnknownProductsError } from '../domain/errors';
import { OrderCreatedEvent } from '../domain/events/order-created.event';
import { calculateOrderTotals } from '../domain/order-total';
import { OrderStatus } from '../domain/order-status.enum';
import { CreateOrderDto } from '../dto/create-order.dto';
import { OrderItem } from '../../database/entities/order-item.entity';
import { Order } from '../../database/entities/order.entity';

export type ReprocessResult =
  | { outcome: 'REQUEUED'; order: Order }
  | { outcome: 'NOT_FAILED'; status: OrderStatus }
  | { outcome: 'NOT_FOUND' };

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(Order)
    private readonly orders: Repository<Order>,
    @InjectRepository(OrderItem)
    private readonly items: Repository<OrderItem>,
    @InjectRepository(Product)
    private readonly products: Repository<Product>,
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

    const order = await this.dataSource.transaction(async (manager) => {
      const order = await manager.save(
        manager.create(Order, {
          customerName: input.customerName,
          total,
          status: OrderStatus.PENDING,
          createdBySub: user.sub,
          correlationId,
        }),
      );
      // Items are stored as sent (a repeated product stays two lines); they
      // are only aggregated per product when stock is reserved.
      order.items = await manager.save(
        input.items.map((item, index) => {
          const product = catalog.get(item.productName.toLowerCase())!;
          return manager.create(OrderItem, {
            orderId: order.id,
            productId: product.id,
            productName: product.name,
            quantity: item.quantity,
            unitPrice: item.price,
            subtotal: subtotals[index],
          });
        }),
      );
      await this.outboxWriter.write(
        manager,
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
  async findOne(id: string, user: AuthenticatedUser): Promise<Order | null> {
    return this.orders.findOne({
      where: { id, ...this.visibleTo(user) },
      relations: { items: true },
      order: { items: { id: 'ASC' } },
    });
  }

  /**
   * Newest first. Two queries (page of orders, then their items) instead of
   * a join: LIMIT on a joined result would count item rows, not orders.
   */
  async list(
    request: PageRequest,
    user: AuthenticatedUser,
  ): Promise<Page<Order>> {
    const [orders, total] = await this.orders.findAndCount({
      where: this.visibleTo(user),
      order: { createdAt: 'DESC', id: 'DESC' },
      skip: pageOffset(request),
      take: request.limit,
    });

    const items = orders.length
      ? await this.items.find({
          where: { orderId: In(orders.map((order) => order.id)) },
          order: { id: 'ASC' },
        })
      : [];
    for (const order of orders) {
      order.items = items.filter((item) => item.orderId === order.id);
    }

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
    return this.dataSource.transaction(async (manager) => {
      const { affected } = await manager.update(
        Order,
        { id, status: OrderStatus.FAILED },
        { status: OrderStatus.PENDING, failureReason: null },
      );
      if (!affected) {
        const current = await manager.findOne(Order, {
          select: { id: true, status: true },
          where: { id },
        });
        return current
          ? { outcome: 'NOT_FAILED', status: current.status }
          : { outcome: 'NOT_FOUND' };
      }

      const order = await manager.findOneOrFail(Order, {
        where: { id },
        relations: { items: true },
        order: { items: { id: 'ASC' } },
      });
      // Same correlation id as the original request: the whole life of the
      // order stays traceable under one id.
      await this.outboxWriter.write(
        manager,
        new OrderCreatedEvent(order.id, order.correlationId ?? randomUUID()),
      );
      return { outcome: 'REQUEUED', order };
    });
  }

  /** ADMIN sees every order; anyone else only the ones they created. */
  private visibleTo(user: AuthenticatedUser): FindOptionsWhere<Order> {
    return user.roles.includes(Role.ADMIN) ? {} : { createdBySub: user.sub };
  }

  /**
   * Catalog lookup keyed by lower-cased name, matching MySQL's
   * case-insensitive collation. Unknown names reject the whole order.
   */
  private async findProducts(names: string[]): Promise<Map<string, Product>> {
    const found = await this.products.findBy({ name: In([...new Set(names)]) });
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
