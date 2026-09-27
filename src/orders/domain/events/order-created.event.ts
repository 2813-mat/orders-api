import { DomainEvent } from '../../../common/events/domain-event';

export const ORDER_CREATED_EVENT = 'order.created';

export interface OrderCreatedPayload extends Record<string, unknown> {
  orderId: string;
  correlationId: string;
}

/** Carries identifiers only: consumers re-read the order from the database. */
export class OrderCreatedEvent implements DomainEvent<OrderCreatedPayload> {
  readonly eventType = ORDER_CREATED_EVENT;
  readonly aggregateType = 'order';

  constructor(
    readonly aggregateId: string,
    readonly correlationId: string,
  ) {}

  get payload(): OrderCreatedPayload {
    return { orderId: this.aggregateId, correlationId: this.correlationId };
  }
}
