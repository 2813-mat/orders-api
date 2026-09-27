import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, In, Repository } from 'typeorm';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { OutboxWriter } from '../outbox/outbox.writer';
import { Product } from '../products/product.entity';
import { UnknownProductsError } from './domain/errors';
import { OrderCreatedEvent } from './domain/events/order-created.event';
import { calculateOrderTotals } from './domain/order-total';
import { OrderStatus } from './domain/order-status.enum';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderItem } from './entities/order-item.entity';
import { Order } from './entities/order.entity';

@Injectable()
export class OrdersService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
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
    const correlationId = randomUUID();

    return this.dataSource.transaction(async (manager) => {
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
