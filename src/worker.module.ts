import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/app-config.module';
import { DatabaseModule } from './database/database.module';
import { OrderProcessingModule } from './orders/processing/order-processing.module';

/** Order processing process: consumes the `orders` queue, no HTTP. */
@Module({
  imports: [AppConfigModule, DatabaseModule, OrderProcessingModule],
})
export class WorkerModule {}
