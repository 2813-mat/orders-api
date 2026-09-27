import { Module } from '@nestjs/common';
import { TransactionRunner } from '../database/transaction-runner';
import { ProductsModule } from '../products/products.module';
import { OrderProcessor } from './processors/order.processor';
import { OrdersQueueModule } from './queue/orders-queue.module';
import { OrdersRepository } from './repositories/orders.repository';
import { StockReservationsRepository } from './repositories/stock-reservations.repository';
import { OrderProcessingService } from './services/order-processing.service';

/** Queue side of orders (worker process). */
@Module({
  imports: [OrdersQueueModule, ProductsModule],
  providers: [
    OrderProcessingService,
    OrderProcessor,
    OrdersRepository,
    StockReservationsRepository,
    TransactionRunner,
  ],
  exports: [OrderProcessingService],
})
export class OrderProcessingModule {}
