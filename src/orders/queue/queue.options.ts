import { DefaultJobOptions } from 'bullmq';
import { EnvironmentVariables } from '../../config/env.validation';

export type QueueConnectionEnv = Pick<
  EnvironmentVariables,
  'REDIS_HOST' | 'REDIS_PORT'
>;

export type OrdersJobEnv = Pick<
  EnvironmentVariables,
  'QUEUE_ATTEMPTS' | 'QUEUE_BACKOFF_MS'
>;

export function buildQueueConnection(env: QueueConnectionEnv) {
  return { host: env.REDIS_HOST, port: env.REDIS_PORT };
}

export function buildOrdersJobOptions(env: OrdersJobEnv): DefaultJobOptions {
  return {
    attempts: env.QUEUE_ATTEMPTS,
    backoff: { type: 'exponential', delay: env.QUEUE_BACKOFF_MS },
    // Completed jobs are only history (the order row holds the outcome);
    // failed ones stay for inspection.
    removeOnComplete: 1000,
    removeOnFail: false,
  };
}

/** Nobody consumes the DLQ: its jobs wait there until someone looks at them. */
export const DEAD_LETTER_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 1,
  removeOnComplete: false,
  removeOnFail: false,
};
