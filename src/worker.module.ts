import { Module } from '@nestjs/common';
import { LoggingModule } from './common/logging/logging.module';
import { AppConfigModule } from './config/app-config.module';
import { DatabaseModule } from './database/database.module';
import { OrderProcessingModule } from './orders/processing/order-processing.module';

/** Order processing process: consumes the `orders` queue, no HTTP. */
@Module({
  imports: [
    AppConfigModule,
    LoggingModule.forRoot({ http: false }),
    DatabaseModule,
    OrderProcessingModule,
  ],
})
export class WorkerModule {}
