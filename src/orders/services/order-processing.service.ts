import { Injectable } from '@nestjs/common';
import { Order } from '../../database/entities/order.entity';
import { TransactionRunner } from '../../database/transaction-runner';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { InsufficientStockError } from '../domain/errors';
import { OrderStatus } from '../domain/order-status.enum';
import { toReservationLines } from '../domain/reservation-lines';
import { OrdersRepository } from '../repositories/orders.repository';
import { StockReservationsRepository } from '../repositories/stock-reservations.repository';

export enum ReservationOutcome {
  PROCESSED = 'PROCESSED',
  /** Someone got there first (retry, duplicate job): nothing was changed. */
  ALREADY_FINAL = 'ALREADY_FINAL',
  NOT_FOUND = 'NOT_FOUND',
}

@Injectable()
export class OrderProcessingService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly orders: OrdersRepository,
    private readonly products: ProductsRepository,
    private readonly reservations: StockReservationsRepository,
  ) {}

  /**
   * What the worker needs before the simulated work. The status read here is
   * only a shortcut; the authoritative check happens under lock.
   */
  findForProcessing(
    orderId: string,
  ): Promise<Pick<Order, 'id' | 'status' | 'customerName'> | null> {
    return this.orders.findForProcessing(orderId);
  }

  /** Counts one more processing attempt on a still PENDING order. */
  recordAttempt(orderId: string): Promise<void> {
    return this.orders.incrementAttemptsIfPending(orderId);
  }

  /**
   * Reserves the stock of every item and confirms the order, all or nothing:
   *
   * 1. Lock the order (`FOR UPDATE`): a second worker holding the same order
   *    waits here, then sees it is no longer PENDING and does nothing. That is
   *    what keeps a retried or duplicated job from reserving twice.
   * 2. One conditional decrement per product (`WHERE stock >= qty`), in
   *    product id order. Atomic check-and-decrement, so concurrent orders can
   *    never take stock below zero; not enough stock throws, and the whole
   *    transaction (including earlier products) rolls back.
   * 3. One reservation row per product; its UNIQUE (order, product) makes a
   *    double reservation impossible even if step 1 were skipped.
   *
   * @throws InsufficientStockError after rolling back; mark the order FAILED
   * with {@link markFailed}, outside this transaction.
   */
  async reserveAndConfirm(orderId: string): Promise<ReservationOutcome> {
    return this.transactions.run(async (tx) => {
      const order = await this.orders.lockForUpdate(tx, orderId);
      if (!order) {
        return ReservationOutcome.NOT_FOUND;
      }
      if (order.status !== OrderStatus.PENDING) {
        return ReservationOutcome.ALREADY_FINAL;
      }

      const items = await this.orders.findItems(tx, orderId);
      for (const line of toReservationLines(items)) {
        const taken = await this.products.decrementStockIfAvailable(
          tx,
          line.productId,
          line.quantity,
        );
        if (!taken) {
          throw new InsufficientStockError(line.productName);
        }
        await this.reservations.insert(tx, {
          orderId,
          productId: line.productId,
          quantity: line.quantity,
        });
      }

      await this.orders.markProcessed(tx, orderId);
      return ReservationOutcome.PROCESSED;
    });
  }

  /**
   * Only a PENDING order can fail: never overwrites a final state that another
   * worker may have written meanwhile. Returns whether the order changed.
   */
  markFailed(orderId: string, reason: string): Promise<boolean> {
    return this.orders.markFailedIfPending(orderId, reason);
  }
}
