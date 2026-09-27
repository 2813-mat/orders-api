import { Module } from '@nestjs/common';
import { TransactionRunner } from '../database/transaction-runner';
import { OrdersQueueModule } from '../orders/queue/orders-queue.module';
import { OutboxEventsRepository } from './repositories/outbox-events.repository';
import { OutboxRelay } from './services/outbox.relay';

@Module({
  imports: [OrdersQueueModule],
  providers: [OutboxRelay, OutboxEventsRepository, TransactionRunner],
  exports: [OutboxRelay],
})
export class OutboxRelayModule {}
