import { Controller, Get } from '@nestjs/common';
import { Roles } from '../../../src/auth/decorators/roles.decorator';
import { Public } from '../../../src/auth/decorators/public.decorator';
import { Role } from '../../../src/auth/role.enum';
import { AuthTestApp, createAuthTestApp } from '../../support/auth-test-app';

@Controller('admin-area')
@Roles(Role.ADMIN)
class AdminAreaController {
  @Get()
  adminOnly() {
    return { area: 'admin' };
  }

  /** Handler-level @Roles overrides the controller-level one. */
  @Get('shared')
  @Roles(Role.ADMIN, Role.USER)
  shared() {
    return { area: 'shared' };
  }
}

@Controller('authenticated')
class AuthenticatedController {
  @Get()
  anyRole() {
    return { area: 'authenticated' };
  }

  @Public()
  @Get('public')
  open() {
    return { area: 'public' };
  }
}

describe('Role-based access control (real guards)', () => {
  let t: AuthTestApp;

  beforeAll(async () => {
    t = await createAuthTestApp([AdminAreaController, AuthenticatedController]);
  });

  afterAll(() => t.close());

  const tokenWith = (roles: string[], username = 'someone') =>
    t.idp.signToken({ roles, username });

  it('authenticates before authorizing: no token on an ADMIN route is 401, not 403', async () => {
    await t.get('/admin-area').expect(401);
  });

  it('lets ADMIN into an ADMIN route', async () => {
    await t
      .get('/admin-area', await tokenWith(['ADMIN']))
      .expect(200, { area: 'admin' });
  });

  it('forbids USER on an ADMIN route', async () => {
    await t.get('/admin-area', await tokenWith(['USER'])).expect(403);
  });

  it('forbids a service account whose only role is USER', async () => {
    const token = await tokenWith(['USER'], 'service-account-orders-api');
    await t.get('/admin-area', token).expect(403);
  });

  it('accepts any of the listed roles on a handler-level @Roles', async () => {
    await t
      .get('/admin-area/shared', await tokenWith(['USER']))
      .expect(200, { area: 'shared' });
  });

  it('forbids a token with no role the API knows about', async () => {
    const token = await tokenWith(['default-roles-orders', 'offline_access']);
    await t.get('/admin-area/shared', token).expect(403);
  });

  it('does not accept ADMIN granted only as a client role', async () => {
    const token = await t.idp.signToken({
      roles: [],
      claims: { resource_access: { 'orders-api': { roles: ['ADMIN'] } } },
    });
    await t.get('/admin-area', token).expect(403);
  });

  it('lets any authenticated user into a route without @Roles', async () => {
    await t
      .get('/authenticated', await tokenWith([]))
      .expect(200, { area: 'authenticated' });
  });

  it('keeps @Public routes open', async () => {
    await t.get('/authenticated/public').expect(200, { area: 'public' });
  });
});
