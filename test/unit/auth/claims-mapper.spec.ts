import {
  InvalidTokenClaimsError,
  mapClaimsToUser,
} from '../../../src/auth/claims-mapper';
import { Role } from '../../../src/auth/role.enum';
import { UserType } from '../../../src/users/user-type.enum';

describe('mapClaimsToUser', () => {
  it('maps a Keycloak user token', () => {
    expect(
      mapClaimsToUser({
        sub: '8d1c2a4e-6f0b-4c1e-9a3d-1f2e3a4b5c01',
        preferred_username: 'admin',
        email: 'admin@orders.local',
        realm_access: { roles: ['ADMIN', 'USER'] },
      }),
    ).toEqual({
      sub: '8d1c2a4e-6f0b-4c1e-9a3d-1f2e3a4b5c01',
      username: 'admin',
      email: 'admin@orders.local',
      roles: [Role.ADMIN, Role.USER],
      type: UserType.USER,
    });
  });

  it('identifies a service account by its Keycloak username prefix', () => {
    const user = mapClaimsToUser({
      sub: 'sa-sub',
      preferred_username: 'service-account-orders-api',
      realm_access: { roles: ['USER'] },
    });

    expect(user.type).toBe(UserType.SERVICE_ACCOUNT);
    expect(user.email).toBeNull();
  });

  it('keeps only the roles the API knows about', () => {
    const user = mapClaimsToUser({
      sub: 'sub',
      preferred_username: 'user',
      realm_access: {
        roles: ['USER', 'default-roles-orders', 'offline_access'],
      },
    });

    expect(user.roles).toEqual([Role.USER]);
  });

  it('ignores client roles: authorization uses realm roles only', () => {
    const user = mapClaimsToUser({
      sub: 'sub',
      preferred_username: 'user',
      resource_access: { 'orders-api': { roles: ['ADMIN'] } },
    });

    expect(user.roles).toEqual([]);
  });

  it('handles missing optional claims', () => {
    expect(mapClaimsToUser({ sub: 'sub' })).toEqual({
      sub: 'sub',
      username: 'sub',
      email: null,
      roles: [],
      type: UserType.USER,
    });
  });

  it.each([{}, { sub: '' }, { sub: 42 }])(
    'rejects a token without a valid sub (%j)',
    (claims) => {
      expect(() => mapClaimsToUser(claims as never)).toThrow(
        InvalidTokenClaimsError,
      );
    },
  );

  it('rejects malformed realm_access.roles instead of trusting it', () => {
    expect(() =>
      mapClaimsToUser({
        sub: 'sub',
        realm_access: { roles: 'ADMIN' as unknown as string[] },
      }),
    ).toThrow(InvalidTokenClaimsError);
  });
});
