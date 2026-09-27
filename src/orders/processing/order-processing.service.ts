import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { Product } from '../../products/product.entity';
import { InsufficientStockError } from '../domain/errors';
import { OrderStatus } from '../domain/order-status.enum';
import { toReservationLines } from '../domain/reservation-lines';
import { OrderItem } from '../entities/order-item.entity';
import { Order } from '../entities/order.entity';
import { StockReservation } from '../entities/stock-reservation.entity';

export enum ReservationOutcome {
  PROCESSED = 'PROCESSED',
  /** Someone got there first (retry, duplicate job): nothing was changed. */
  ALREADY_FINAL = 'ALREADY_FINAL',
  NOT_FOUND = 'NOT_FOUND',
}

@Injectable()
export class OrderProcessingService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Cheap check before the simulated work; the real one happens under lock. */
  async currentStatus(orderId: string): Promise<OrderStatus | null> {
    const order = await this.dataSource.getRepository(Order).findOne({
      select: { id: true, status: true },
      where: { id: orderId },
    });
    return order?.status ?? null;
  }

  /**
   * Reserves the stock of every item and confirms the order, all or nothing:
   *
   * 1. `SELECT ... FOR UPDATE` on the order: a second worker holding the same
   *    order waits here, then sees it is no longer PENDING and does nothing.
   *    That is what keeps a retried or duplicated job from reserving twice.
   * 2. One conditional `UPDATE ... WHERE stock >= qty` per product, in product
   *    id order. Atomic check-and-decrement, so concurrent orders can never
   *    take stock below zero; 0 rows affected means not enough stock and the
   *    whole transaction (including earlier products) rolls back.
   * 3. One `stock_reservations` row per product; its UNIQUE (order, product)
   *    makes a double reservation impossible even if step 1 were skipped.
   *
   * @throws InsufficientStockError after rolling back; mark the order FAILED
   * with {@link markFailed}, outside this transaction.
   */
  async reserveAndConfirm(orderId: string): Promise<ReservationOutcome> {
    return this.dataSource.transaction(async (manager) => {
      const order = await manager
        .getRepository(Order)
        .createQueryBuilder('order')
        .setLock('pessimistic_write')
        .where('order.id = :orderId', { orderId })
        .getOne();
      if (!order) {
        return ReservationOutcome.NOT_FOUND;
      }
      if (order.status !== OrderStatus.PENDING) {
        return ReservationOutcome.ALREADY_FINAL;
      }

      const items = await manager.find(OrderItem, { where: { orderId } });
      for (const line of toReservationLines(items)) {
        await this.takeStock(manager, line.productId, line.quantity, () => {
          throw new InsufficientStockError(line.productName);
        });
        await manager.insert(StockReservation, {
          orderId,
          productId: line.productId,
          quantity: line.quantity,
        });
      }

      await manager.update(
        Order,
        { id: orderId },
        {
          status: OrderStatus.PROCESSED,
          processedAt: () => 'CURRENT_TIMESTAMP(3)',
          failureReason: null,
        },
      );
      return ReservationOutcome.PROCESSED;
    });
  }

  /**
   * Only a PENDING order can fail: never overwrites a final state that another
   * worker may have written meanwhile. Returns whether the order changed.
   */
  async markFailed(orderId: string, reason: string): Promise<boolean> {
    const result = await this.dataSource
      .getRepository(Order)
      .update(
        { id: orderId, status: OrderStatus.PENDING },
        { status: OrderStatus.FAILED, failureReason: reason.slice(0, 255) },
      );
    return result.affected === 1;
  }

  private async takeStock(
    manager: EntityManager,
    productId: number,
    quantity: number,
    onInsufficient: () => never,
  ): Promise<void> {
    const result = await manager
      .createQueryBuilder()
      .update(Product)
      .set({ stock: () => 'stock - :quantity' })
      .where('id = :productId AND stock >= :quantity', { productId, quantity })
      .setParameters({ quantity })
      .execute();
    if (result.affected === 0) {
      onInsufficient();
    }
  }
}
