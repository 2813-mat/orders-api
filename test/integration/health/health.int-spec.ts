import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { buildTypeOrmOptions } from '../../../src/database/typeorm.options';
import { HealthModule } from '../../../src/health/health.module';
import { createAuthTestApp } from '../../support/auth-test-app';
import { testDatabaseEnv } from '../../support/database';

const bootHealth = () =>
  createAuthTestApp([], {
    imports: [
      TypeOrmModule.forRoot(buildTypeOrmOptions(testDatabaseEnv())),
      HealthModule,
    ],
  });

describe('GET /health (real MySQL)', () => {
  it('is public and reports the database up', async () => {
    const t = await bootHealth();
    try {
      const { body } = (await t.get('/health').expect(200)) as {
        body: unknown;
      };

      expect(body).toMatchObject({
        status: 'ok',
        info: { database: { status: 'up' } },
        error: {},
      });
    } finally {
      await t.close();
    }
  });

  it('answers 503 when the database is unreachable', async () => {
    const t = await bootHealth();
    const dataSource = t.app.get<DataSource>(getDataSourceToken());
    await dataSource.destroy();
    try {
      const { body } = (await t.get('/health').expect(503)) as {
        body: unknown;
      };

      expect(body).toMatchObject({
        status: 'error',
        error: { database: { status: 'down' } },
      });
    } finally {
      // The connection is already gone; TypeORM refuses to close it twice.
      await t.close().catch(() => undefined);
    }
  });
});
