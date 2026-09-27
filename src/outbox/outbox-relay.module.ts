import { Module } from '@nestjs/common';
import { OrdersQueueModule } from '../orders/queue/orders-queue.module';
import { OutboxRelay } from './services/outbox.relay';

@Module({
  imports: [OrdersQueueModule],
  providers: [OutboxRelay],
  exports: [OutboxRelay],
})
export class OutboxRelayModule {}
