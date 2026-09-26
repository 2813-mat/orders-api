import { Controller, Get } from '@nestjs/common';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Public } from '../../../src/auth/decorators/public.decorator';
import { buildTypeOrmOptions } from '../../../src/database/typeorm.options';
import { User } from '../../../src/users/user.entity';
import { UserType } from '../../../src/users/user-type.enum';
import { UsersModule } from '../../../src/users/users.module';
import { AuthTestApp, createAuthTestApp } from '../../support/auth-test-app';
import { testDatabaseEnv, truncate } from '../../support/database';

@Controller('probe')
class ProbeController {
  @Get()
  authenticated() {
    return { ok: true };
  }

  @Public()
  @Get('public')
  open() {
    return { ok: true };
  }
}

describe('Just-in-time user sync over HTTP (real guards + MySQL)', () => {
  let t: AuthTestApp;
  let dataSource: DataSource;
  const users = () => dataSource.getRepository(User);

  beforeAll(async () => {
    t = await createAuthTestApp([ProbeController], {
      imports: [
        TypeOrmModule.forRoot(buildTypeOrmOptions(testDatabaseEnv())),
        UsersModule,
      ],
      config: { USER_SYNC_INTERVAL_MS: 0 },
    });
    dataSource = t.app.get<DataSource>(getDataSourceToken());
  });
  afterAll(() => t.close());
  beforeEach(() => truncate(dataSource, 'users'));

  it('creates the local profile on the first authenticated request', async () => {
    const sub = '8d1c2a4e-6f0b-4c1e-9a3d-1f2e3a4b5c02';
    const token = await t.idp.signToken({
      sub,
      username: 'user',
      email: 'user@orders.local',
    });

    await t.get('/probe', token).expect(200);

    await expect(
      users().findOneByOrFail({ keycloakSub: sub }),
    ).resolves.toMatchObject({
      username: 'user',
      email: 'user@orders.local',
      type: UserType.USER,
    });
  });

  it('records a service account as SERVICE_ACCOUNT after its first request', async () => {
    const sub = '8d1c2a4e-6f0b-4c1e-9a3d-1f2e3a4b5c03';
    const token = await t.idp.signToken({
      sub,
      username: 'service-account-orders-api',
    });

    await t.get('/probe', token).expect(200);

    await expect(
      users().findOneByOrFail({ keycloakSub: sub }),
    ).resolves.toMatchObject({ type: UserType.SERVICE_ACCOUNT, email: null });
  });

  it('does not create anything for anonymous calls to public routes', async () => {
    await t.get('/probe/public').expect(200);
    await expect(users().count()).resolves.toBe(0);
  });

  it('does not create anything for rejected tokens', async () => {
    const token = await t.idp.signToken({ signWithUntrustedKey: true });
    await t.get('/probe', token).expect(401);
    await expect(users().count()).resolves.toBe(0);
  });
});
