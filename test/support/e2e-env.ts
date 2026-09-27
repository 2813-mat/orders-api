import { FakeIdp } from './fake-idp';

/**
 * setupFiles of the e2e project: runs before any test file is loaded, which
 * matters because AppConfigModule validates the environment when it is
 * imported. DB_* and REDIS_* already come from the Testcontainers globalSetup;
 * the FakeIdp is started by the stack on this fixed port.
 */
export const E2E_IDP_PORT = Number(process.env.E2E_IDP_PORT ?? 48_080);

Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  KEYCLOAK_ISSUER: FakeIdp.ISSUER,
  KEYCLOAK_JWKS_URI: `http://127.0.0.1:${E2E_IDP_PORT}/realms/orders/protocol/openid-connect/certs`,
  KEYCLOAK_AUDIENCE: FakeIdp.AUDIENCE,
  KEYCLOAK_CLIENT_ID: FakeIdp.CLIENT_ID,
  USER_SYNC_INTERVAL_MS: '0',
  QUEUE_ATTEMPTS: '3',
  QUEUE_BACKOFF_MS: '50',
  WORKER_CONCURRENCY: '5',
  PROCESSING_MIN_MS: '10',
  PROCESSING_MAX_MS: '30',
  OUTBOX_POLL_INTERVAL_MS: '50',
  OUTBOX_BATCH_SIZE: '50',
  OUTBOX_MAX_ATTEMPTS: '10',
  OUTBOX_PUBLISH_TIMEOUT_MS: '2000',
});
