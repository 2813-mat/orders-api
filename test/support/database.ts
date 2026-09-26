import { DataSource } from 'typeorm';
import {
  buildTypeOrmOptions,
  DatabaseEnv,
} from '../../src/database/typeorm.options';

/** DB_* published by test/support/global-setup.ts (Testcontainers MySQL). */
export function testDatabaseEnv(): DatabaseEnv {
  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
  if (!DB_HOST || !DB_PORT || !DB_USER || !DB_PASSWORD || !DB_NAME) {
    throw new Error(
      'Test database env missing: run through `npm run test:int` (globalSetup)',
    );
  }
  return {
    DB_HOST,
    DB_PORT: Number(DB_PORT),
    DB_USER,
    DB_PASSWORD,
    DB_NAME,
  };
}

export async function createTestDataSource(): Promise<DataSource> {
  return new DataSource(buildTypeOrmOptions(testDatabaseEnv())).initialize();
}

/** Empties the given tables; FK checks are off so order doesn't matter. */
export async function truncate(
  dataSource: DataSource,
  ...tables: string[]
): Promise<void> {
  await dataSource.transaction(async (manager) => {
    await manager.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of tables) {
      await manager.query(`TRUNCATE TABLE \`${table}\``);
    }
    await manager.query('SET FOREIGN_KEY_CHECKS = 1');
  });
}
