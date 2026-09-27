import { Injectable } from '@nestjs/common';
import { StockReservation } from '../../database/entities/stock-reservation.entity';
import { Transaction } from '../../database/transaction-runner';

@Injectable()
export class StockReservationsRepository {
  /**
   * UNIQUE (order_id, product_id): a second reservation of the same product
   * for the same order fails and rolls the whole transaction back.
   */
  async insert(
    tx: Transaction,
    reservation: Pick<StockReservation, 'orderId' | 'productId' | 'quantity'>,
  ): Promise<void> {
    await tx.insert(StockReservation, reservation);
  }
}
