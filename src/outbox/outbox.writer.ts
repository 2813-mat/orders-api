import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { DomainEvent } from '../common/events/domain-event';
import { OutboxEvent } from './outbox-event.entity';

@Injectable()
export class OutboxWriter {
  /**
   * Takes the caller's transactional EntityManager on purpose: the event must
   * commit or roll back together with the change it describes. A default
   * repository would write on its own connection and break that guarantee.
   */
  async write(
    manager: EntityManager,
    event: DomainEvent,
  ): Promise<OutboxEvent> {
    if (!manager.queryRunner?.isTransactionActive) {
      throw new Error('OutboxWriter.write must run inside a transaction');
    }
    return manager.save(
      manager.create(OutboxEvent, {
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        payload: event.payload,
        correlationId: event.correlationId,
      }),
    );
  }
}
