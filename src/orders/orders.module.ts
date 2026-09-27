import { Module } from '@nestjs/common';
import { TransactionRunner } from '../database/transaction-runner';
import { OutboxModule } from '../outbox/outbox.module';
import { ProductsModule } from '../products/products.module';
import { OrdersController } from './controllers/orders.controller';
import { OrdersRepository } from './repositories/orders.repository';
import { OrdersService } from './services/orders.service';

/** HTTP side of orders (API process). */
@Module({
  imports: [ProductsModule, OutboxModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrdersRepository, TransactionRunner],
})
export class OrdersModule {}
