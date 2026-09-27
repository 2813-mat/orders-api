import {
  buildQueueConnection,
  DEAD_LETTER_JOB_OPTIONS,
  buildOrdersJobOptions,
} from '../../../../src/orders/queue/queue.options';

describe('queue options', () => {
  it('connects to the configured Redis', () => {
    expect(
      buildQueueConnection({ REDIS_HOST: 'redis', REDIS_PORT: 6380 }),
    ).toEqual({ host: 'redis', port: 6380 });
  });

  it('retries order jobs with exponential backoff from env', () => {
    expect(
      buildOrdersJobOptions({ QUEUE_ATTEMPTS: 4, QUEUE_BACKOFF_MS: 250 }),
    ).toEqual({
      attempts: 4,
      backoff: { type: 'exponential', delay: 250 },
      removeOnComplete: 1000,
      removeOnFail: false,
    });
  });

  it('never retries nor evicts dead-letter jobs', () => {
    expect(DEAD_LETTER_JOB_OPTIONS).toEqual({
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false,
    });
  });
});
