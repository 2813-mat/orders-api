export const ORDERS_QUEUE = 'orders';
export const ORDERS_DEAD_LETTER_QUEUE = 'orders-dlq';

export const ORDER_CREATED_JOB = 'order.created';
export const ORDER_FAILED_JOB = 'order.failed';

/**
 * Only identifiers travel through the queue: the worker re-reads the order from
 * MySQL (source of truth) and never trusts the payload for business data.
 * Published by the outbox relay with `jobId = outbox_events.id`, so republishing
 * the same event is deduplicated by BullMQ.
 */
export interface OrderJobData {
  orderId: string;
  correlationId: string;
}

/** Kept in the DLQ for analysis; replay goes through the reprocess endpoint. */
export interface OrderDeadLetterData extends OrderJobData {
  reason: string;
  attempts: number;
  failedAt: string;
}
