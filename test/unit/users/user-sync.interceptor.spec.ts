import { CallHandler, ExecutionContext, Logger } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { AuthenticatedUser } from '../../../src/auth/authenticated-user';
import { Role } from '../../../src/auth/role.enum';
import { UserSyncInterceptor } from '../../../src/users/user-sync.interceptor';
import { UserType } from '../../../src/users/user-type.enum';
import { UsersService } from '../../../src/users/users.service';

const user: AuthenticatedUser = {
  sub: 'sub',
  username: 'user',
  email: null,
  roles: [Role.USER],
  type: UserType.USER,
};

const httpContext = (reqUser?: AuthenticatedUser) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user: reqUser }) }),
  }) as unknown as ExecutionContext;

const handler: CallHandler = { handle: () => of('handler result') };

describe('UserSyncInterceptor', () => {
  let syncFromToken: jest.Mock;
  let interceptor: UserSyncInterceptor;

  beforeEach(() => {
    syncFromToken = jest.fn().mockResolvedValue(true);
    interceptor = new UserSyncInterceptor({
      syncFromToken,
    } as unknown as UsersService);
  });

  it('syncs the authenticated user before running the handler', async () => {
    const result = await lastValueFrom(
      await interceptor.intercept(httpContext(user), handler),
    );

    expect(syncFromToken).toHaveBeenCalledWith(user);
    expect(result).toBe('handler result');
  });

  it('skips anonymous requests (public routes)', async () => {
    await lastValueFrom(await interceptor.intercept(httpContext(), handler));
    expect(syncFromToken).not.toHaveBeenCalled();
  });

  it('never fails the request when the profile write fails', async () => {
    syncFromToken.mockRejectedValue(new Error('ECONNREFUSED'));
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    const result = await lastValueFrom(
      await interceptor.intercept(httpContext(user), handler),
    );

    expect(result).toBe('handler result');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
