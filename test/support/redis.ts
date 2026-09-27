import { QueueConnectionEnv } from '../../src/orders/queue/queue.options';

/** REDIS_* published by test/support/global-setup.ts (Testcontainers Redis). */
export function testRedisEnv(): QueueConnectionEnv {
  const { REDIS_HOST, REDIS_PORT } = process.env;
  if (!REDIS_HOST || !REDIS_PORT) {
    throw new Error(
      'Test Redis env missing: run through `npm run test:int` (globalSetup)',
    );
  }
  return { REDIS_HOST, REDIS_PORT: Number(REDIS_PORT) };
}
