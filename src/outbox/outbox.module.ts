import { Module } from '@nestjs/common';
import { OutboxEventsRepository } from './repositories/outbox-events.repository';
import { OutboxWriter } from './services/outbox.writer';

@Module({
  providers: [OutboxWriter, OutboxEventsRepository],
  exports: [OutboxWriter],
})
export class OutboxModule {}
