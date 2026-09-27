import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, FindOptionsWhere, In } from 'typeorm';
import { OrderItem } from '../../database/entities/order-item.entity';
import { Order } from '../../database/entities/order.entity';
import { Transaction } from '../../database/transaction-runner';
import { PageRequest, pageOffset } from '../../common/pagination/page';
import { OrderStatus } from '../domain/order-status.enum';

export interface NewOrder {
  customerName: string;
  total: number;
  createdBySub: string;
  correlationId: string;
}

export type NewOrderItem = Pick<
  OrderItem,
  'productId' | 'productName' | 'quantity' | 'unitPrice' | 'subtotal'
>;

/**
 * `orders` and `order_items`: the order aggregate. `ownerSub` narrows a query
 * to one user's orders; `undefined` means every order (the caller decides who
 * may see what).
 */
@Injectable()
export class OrdersRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Inserts a PENDING order and its lines as sent (repeated products stay separate). */
  async insertWithItems(
    tx: Transaction,
    data: NewOrder,
    items: NewOrderItem[],
  ): Promise<Order> {
    const order = await tx.save(
      tx.create(Order, { ...data, status: OrderStatus.PENDING }),
    );
    order.items = await tx.save(
      items.map((item) => tx.create(OrderItem, { ...item, orderId: order.id })),
    );
    return order;
  }

  findWithItems(
    id: string,
    ownerSub?: string,
    tx?: Transaction,
  ): Promise<Order | null> {
    return this.orders(tx).findOne({
      where: { id, ...owner(ownerSub) },
      relations: { items: true },
      order: { items: { id: 'ASC' } },
    });
  }

  /**
   * Newest first. Two queries (page of orders, then their items) instead of
   * a join: LIMIT on a joined result would count item rows, not orders.
   */
  async findPage(
    request: PageRequest,
    ownerSub?: string,
  ): Promise<[Order[], number]> {
    const [orders, total] = await this.orders().findAndCount({
      where: owner(ownerSub),
      order: { createdAt: 'DESC', id: 'DESC' },
      skip: pageOffset(request),
      take: request.limit,
    });
    const items = orders.length
      ? await this.dataSource.getRepository(OrderItem).find({
          where: { orderId: In(orders.map((order) => order.id)) },
          order: { id: 'ASC' },
        })
      : [];
    for (const order of orders) {
      order.items = items.filter((item) => item.orderId === order.id);
    }
    return [orders, total];
  }

  findStatus(
    id: string,
    tx?: Transaction,
  ): Promise<Pick<Order, 'id' | 'status'> | null> {
    return this.orders(tx).findOne({
      select: { id: true, status: true },
      where: { id },
    });
  }

  findForProcessing(
    id: string,
  ): Promise<Pick<Order, 'id' | 'status' | 'customerName'> | null> {
    return this.orders().findOne({
      select: { id: true, status: true, customerName: true },
      where: { id },
    });
  }

  /**
   * `SELECT ... FOR UPDATE`: another transaction locking the same order waits
   * here until this one ends, then reads the state it left.
   */
  lockForUpdate(tx: Transaction, id: string): Promise<Order | null> {
    return this.orders(tx)
      .createQueryBuilder('order')
      .setLock('pessimistic_write')
      .where('order.id = :id', { id })
      .getOne();
  }

  findItems(tx: Transaction, orderId: string): Promise<OrderItem[]> {
    return tx.getRepository(OrderItem).find({ where: { orderId } });
  }

  async markProcessed(tx: Transaction, id: string): Promise<void> {
    await this.orders(tx).update(
      { id },
      {
        status: OrderStatus.PROCESSED,
        processedAt: () => 'CURRENT_TIMESTAMP(3)',
        failureReason: null,
      },
    );
  }

  /** Only a PENDING order changes; returns whether it did. */
  async markFailedIfPending(id: string, reason: string): Promise<boolean> {
    const result = await this.orders().update(
      { id, status: OrderStatus.PENDING },
      // failure_reason is VARCHAR(255)
      { status: OrderStatus.FAILED, failureReason: reason.slice(0, 255) },
    );
    return result.affected === 1;
  }

  /** Only a FAILED order changes; returns whether it did. */
  async requeueIfFailed(tx: Transaction, id: string): Promise<boolean> {
    const result = await this.orders(tx).update(
      { id, status: OrderStatus.FAILED },
      { status: OrderStatus.PENDING, failureReason: null },
    );
    return result.affected === 1;
  }

  async incrementAttemptsIfPending(id: string): Promise<void> {
    await this.orders().increment(
      { id, status: OrderStatus.PENDING },
      'processingAttempts',
      1,
    );
  }

  private orders(tx?: Transaction) {
    return (tx ?? this.dataSource.manager).getRepository(Order);
  }
}

function owner(ownerSub?: string): FindOptionsWhere<Order> {
  return ownerSub === undefined ? {} : { createdBySub: ownerSub };
}
