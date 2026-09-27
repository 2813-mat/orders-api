import { Injectable } from '@nestjs/common';
import { DomainEvent } from '../../common/events/domain-event';
import { OutboxEvent } from '../../database/entities/outbox-event.entity';
import { Transaction } from '../../database/transaction-runner';
import { OutboxEventsRepository } from '../repositories/outbox-events.repository';

@Injectable()
export class OutboxWriter {
  constructor(private readonly events: OutboxEventsRepository) {}

  /**
   * Takes the caller's transaction on purpose: the event must commit or roll
   * back together with the change it describes. Writing on its own connection
   * would break that guarantee, so it refuses to run outside a transaction.
   */
  async write(tx: Transaction, event: DomainEvent): Promise<OutboxEvent> {
    if (!tx.queryRunner?.isTransactionActive) {
      throw new Error('OutboxWriter.write must run inside a transaction');
    }
    return this.events.insert(tx, {
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.payload,
      correlationId: event.correlationId,
    });
  }
}
