import { validateEnv } from '../../../src/config/env.validation';

const validEnv = {
  DB_HOST: 'mysql',
  DB_USER: 'orders',
  DB_PASSWORD: 'orders',
  DB_NAME: 'orders',
  REDIS_HOST: 'redis',
  KEYCLOAK_ISSUER: 'http://localhost:8080/realms/orders',
  KEYCLOAK_JWKS_URI:
    'http://keycloak:8080/realms/orders/protocol/openid-connect/certs',
  KEYCLOAK_AUDIENCE: 'orders-api',
  KEYCLOAK_CLIENT_ID: 'orders-api',
};

describe('validateEnv', () => {
  it('accepts the minimal env and applies defaults', () => {
    expect(validateEnv(validEnv)).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      QUEUE_ATTEMPTS: 3,
      PROCESSING_MIN_MS: 1000,
      PROCESSING_MAX_MS: 2000,
      LOG_LEVEL: 'info',
      USER_SYNC_INTERVAL_MS: 300_000,
    });
  });

  it('coerces numeric strings coming from process.env', () => {
    expect(validateEnv({ ...validEnv, DB_PORT: '3307' }).DB_PORT).toBe(3307);
  });

  it('ignores unrelated process.env variables', () => {
    expect(() => validateEnv({ ...validEnv, PATH: '/usr/bin' })).not.toThrow();
  });

  it('reports every missing variable at once', () => {
    expect(() =>
      validateEnv({ ...validEnv, DB_HOST: undefined, REDIS_HOST: undefined }),
    ).toThrow(/DB_HOST[\s\S]*REDIS_HOST/);
  });

  it('rejects PROCESSING_MAX_MS lower than PROCESSING_MIN_MS', () => {
    expect(() =>
      validateEnv({
        ...validEnv,
        PROCESSING_MIN_MS: '2000',
        PROCESSING_MAX_MS: '1000',
      }),
    ).toThrow(/PROCESSING_MAX_MS/);
  });

  it('rejects an invalid Keycloak URL', () => {
    expect(() =>
      validateEnv({ ...validEnv, KEYCLOAK_JWKS_URI: 'not-a-url' }),
    ).toThrow(/KEYCLOAK_JWKS_URI/);
  });

  it('rejects a non-numeric port', () => {
    expect(() => validateEnv({ ...validEnv, PORT: 'abc' })).toThrow(/PORT/);
  });
});
