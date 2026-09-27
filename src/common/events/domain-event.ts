/**
 * Something that happened in the domain and must reach other processes.
 * Persisted in `outbox_events` in the same transaction as the change it
 * describes; the relay later publishes `payload` under `eventType`.
 */
export interface DomainEvent<
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: TPayload;
  readonly correlationId: string | null;
}
