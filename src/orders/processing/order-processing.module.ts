import { Module } from '@nestjs/common';
import { OrdersQueueModule } from '../queue/orders-queue.module';
import { OrderProcessingService } from './order-processing.service';
import { OrderProcessor } from './order.processor';

@Module({
  imports: [OrdersQueueModule],
  providers: [OrderProcessingService, OrderProcessor],
  exports: [OrderProcessingService],
})
export class OrderProcessingModule {}
