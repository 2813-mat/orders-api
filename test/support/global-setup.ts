import { MySqlContainer, StartedMySqlContainer } from '@testcontainers/mysql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { DataSource } from 'typeorm';
import { buildTypeOrmOptions } from '../../src/database/typeorm.options';

declare global {
  var __MYSQL_CONTAINER__: StartedMySqlContainer | undefined;
  var __REDIS_CONTAINER__: StartedRedisContainer | undefined;
}

/**
 * One real MySQL and one real Redis for the whole integration run: started once
 * (MySQL migrated with the same migrations production uses) and exposed to the
 * tests through DB_* and REDIS_* env.
 */
export default async function globalSetup(): Promise<void> {
  const redisStarting = new RedisContainer('redis:7-alpine').start();
  const container = await new MySqlContainer('mysql:8.4')
    .withDatabase('orders')
    .withUsername('orders')
    .withUserPassword('orders')
    .start();

  process.env.DB_HOST = container.getHost();
  process.env.DB_PORT = String(container.getPort());
  process.env.DB_USER = container.getUsername();
  process.env.DB_PASSWORD = container.getUserPassword();
  process.env.DB_NAME = container.getDatabase();

  const dataSource = new DataSource(
    buildTypeOrmOptions({
      DB_HOST: container.getHost(),
      DB_PORT: container.getPort(),
      DB_USER: container.getUsername(),
      DB_PASSWORD: container.getUserPassword(),
      DB_NAME: container.getDatabase(),
    }),
  );
  await dataSource.initialize();
  try {
    await dataSource.runMigrations();
  } finally {
    await dataSource.destroy();
  }

  globalThis.__MYSQL_CONTAINER__ = container;

  const redis = await redisStarting;
  process.env.REDIS_HOST = redis.getHost();
  process.env.REDIS_PORT = String(redis.getPort());
  globalThis.__REDIS_CONTAINER__ = redis;
}
