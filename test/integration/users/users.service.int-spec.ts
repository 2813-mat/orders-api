import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AuthenticatedUser } from '../../../src/auth/authenticated-user';
import { Role } from '../../../src/auth/role.enum';
import { buildTypeOrmOptions } from '../../../src/database/typeorm.options';
import { User } from '../../../src/users/user.entity';
import { UserType } from '../../../src/users/user-type.enum';
import { UsersModule } from '../../../src/users/users.module';
import { UsersService } from '../../../src/users/users.service';
import { testDatabaseEnv, truncate } from '../../support/database';

const ONE_HOUR = 3_600_000;

async function bootUsers(syncIntervalMs: number) {
  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => ({ USER_SYNC_INTERVAL_MS: syncIntervalMs })],
      }),
      TypeOrmModule.forRoot(buildTypeOrmOptions(testDatabaseEnv())),
      UsersModule,
    ],
  }).compile();
  return {
    moduleRef,
    service: moduleRef.get(UsersService),
    dataSource: moduleRef.get<DataSource>(getDataSourceToken()),
  };
}

const aUser = (
  overrides: Partial<AuthenticatedUser> = {},
): AuthenticatedUser => ({
  sub: randomUUID(),
  username: 'user',
  email: 'user@orders.local',
  roles: [Role.USER],
  type: UserType.USER,
  ...overrides,
});

describe('UsersService.syncFromToken (real MySQL)', () => {
  describe('without throttling', () => {
    let ctx: Awaited<ReturnType<typeof bootUsers>>;
    const users = () => ctx.dataSource.getRepository(User);

    beforeAll(async () => {
      ctx = await bootUsers(0);
    });
    afterAll(() => ctx.moduleRef.close());
    beforeEach(() => truncate(ctx.dataSource, 'users'));

    it('creates the local profile the first time a sub is seen', async () => {
      const user = aUser({ username: 'admin', email: 'admin@orders.local' });

      await expect(ctx.service.syncFromToken(user)).resolves.toBe(true);

      const row = await users().findOneByOrFail({ keycloakSub: user.sub });
      expect(row).toMatchObject({
        username: 'admin',
        email: 'admin@orders.local',
        type: UserType.USER,
      });
      expect(row.firstSeenAt.getTime()).toBe(row.lastSeenAt.getTime());
    });

    it('refreshes profile data and last_seen_at, keeping id and first_seen_at', async () => {
      const user = aUser({ username: 'old-name', email: 'old@orders.local' });
      await ctx.service.syncFromToken(user);
      const before = await users().findOneByOrFail({ keycloakSub: user.sub });

      await new Promise((resolve) => setTimeout(resolve, 20));
      await ctx.service.syncFromToken({
        ...user,
        username: 'new-name',
        email: null,
      });

      const after = await users().findOneByOrFail({ keycloakSub: user.sub });
      expect(after).toMatchObject({
        id: before.id,
        username: 'new-name',
        email: null,
      });
      expect(after.firstSeenAt.getTime()).toBe(before.firstSeenAt.getTime());
      expect(after.lastSeenAt.getTime()).toBeGreaterThan(
        before.lastSeenAt.getTime(),
      );
    });

    it('stores service accounts with their type and no email', async () => {
      const sa = aUser({
        username: 'service-account-orders-api',
        email: null,
        type: UserType.SERVICE_ACCOUNT,
      });

      await ctx.service.syncFromToken(sa);

      await expect(
        users().findOneByOrFail({ keycloakSub: sa.sub }),
      ).resolves.toMatchObject({ type: UserType.SERVICE_ACCOUNT, email: null });
    });

    it('survives concurrent first requests for the same sub: one row, no error', async () => {
      const user = aUser();

      await Promise.all(
        Array.from({ length: 10 }, () => ctx.service.syncFromToken(user)),
      );

      await expect(users().countBy({ keycloakSub: user.sub })).resolves.toBe(1);
    });
  });

  describe('with throttling', () => {
    let ctx: Awaited<ReturnType<typeof bootUsers>>;
    const users = () => ctx.dataSource.getRepository(User);

    beforeAll(async () => {
      ctx = await bootUsers(ONE_HOUR);
    });
    afterAll(() => ctx.moduleRef.close());
    beforeEach(() => truncate(ctx.dataSource, 'users'));

    it('skips the write for a sub synced within the interval', async () => {
      const user = aUser({ username: 'first' });
      await ctx.service.syncFromToken(user);

      await expect(
        ctx.service.syncFromToken({ ...user, username: 'second' }),
      ).resolves.toBe(false);

      await expect(
        users().findOneByOrFail({ keycloakSub: user.sub }),
      ).resolves.toMatchObject({ username: 'first' });
    });

    it('throttles per sub, not globally', async () => {
      const a = aUser();
      const b = aUser();

      await ctx.service.syncFromToken(a);

      await expect(ctx.service.syncFromToken(b)).resolves.toBe(true);
      await expect(users().count()).resolves.toBe(2);
    });
  });
});
