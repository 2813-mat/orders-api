import { z } from 'zod';

const port = z.coerce.number().int().min(1).max(65535);
const httpUrl = z.url({ protocol: /^https?$/ });

export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: port.default(3000),

    DB_HOST: z.string().min(1),
    DB_PORT: port.default(3306),
    DB_USER: z.string().min(1),
    DB_PASSWORD: z.string().min(1),
    DB_NAME: z.string().min(1),

    REDIS_HOST: z.string().min(1),
    REDIS_PORT: port.default(6379),

    QUEUE_ATTEMPTS: z.coerce.number().int().min(1).default(3),
    QUEUE_BACKOFF_MS: z.coerce.number().int().min(0).default(1000),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(5),
    PROCESSING_MIN_MS: z.coerce.number().int().min(0).default(1000),
    PROCESSING_MAX_MS: z.coerce.number().int().min(0).default(2000),

    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(500),
    OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(50),
    OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(10),

    KEYCLOAK_ISSUER: httpUrl,
    KEYCLOAK_JWKS_URI: httpUrl,
    KEYCLOAK_AUDIENCE: z.string().min(1),
    KEYCLOAK_CLIENT_ID: z.string().min(1),
    /** Min time between two writes of the same user's local profile. */
    USER_SYNC_INTERVAL_MS: z.coerce.number().int().min(0).default(300_000),

    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .refine((env) => env.PROCESSING_MAX_MS >= env.PROCESSING_MIN_MS, {
    message: 'must be greater than or equal to PROCESSING_MIN_MS',
    path: ['PROCESSING_MAX_MS'],
  });

export type EnvironmentVariables = z.infer<typeof envSchema>;

export function validateEnv(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    throw new Error(
      `Invalid environment configuration:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}
