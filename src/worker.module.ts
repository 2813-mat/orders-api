import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/app-config.module';
import { DatabaseModule } from './database/database.module';
import { OrdersQueueModule } from './orders/queue/orders-queue.module';

/** Order processing process: consumes the `orders` queue, no HTTP. */
@Module({
  imports: [AppConfigModule, DatabaseModule, OrdersQueueModule],
})
export class WorkerModule {}
