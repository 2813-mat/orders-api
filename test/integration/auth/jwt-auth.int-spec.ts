import { Controller, Get } from '@nestjs/common';
import { SignJWT } from 'jose';
import request from 'supertest';
import { AuthenticatedUser } from '../../../src/auth/authenticated-user';
import { CurrentUser } from '../../../src/auth/decorators/current-user.decorator';
import { Public } from '../../../src/auth/decorators/public.decorator';
import { UserType } from '../../../src/users/user-type.enum';
import { AuthTestApp, createAuthTestApp } from '../../support/auth-test-app';
import { FakeIdp } from '../../support/fake-idp';

@Controller('probe')
class ProbeController {
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }

  @Public()
  @Get('public')
  open() {
    return { ok: true };
  }
}

const base64url = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

describe('JWT authentication (real JwtStrategy + JWKS)', () => {
  let t: AuthTestApp;
  let idp: FakeIdp;

  beforeAll(async () => {
    t = await createAuthTestApp([ProbeController]);
    idp = t.idp;
  });

  afterAll(() => t.close());

  const get = (path: string, token?: string) => t.get(path, token);

  it('rejects a request without a token', async () => {
    await get('/probe/me').expect(401);
  });

  it('lets @Public() routes through without a token', async () => {
    await get('/probe/public').expect(200, { ok: true });
  });

  it('accepts a valid token and exposes the mapped user', async () => {
    const sub = '8d1c2a4e-6f0b-4c1e-9a3d-1f2e3a4b5c01';
    const token = await idp.signToken({
      sub,
      username: 'admin',
      email: 'admin@orders.local',
      roles: ['ADMIN', 'USER', 'default-roles-orders'],
    });

    const res = await get('/probe/me', token).expect(200);

    expect(res.body).toEqual({
      sub,
      username: 'admin',
      email: 'admin@orders.local',
      roles: ['ADMIN', 'USER'],
      type: UserType.USER,
    });
  });

  it('identifies a service account token', async () => {
    const token = await idp.signToken({
      username: 'service-account-orders-api',
    });

    const res = await get('/probe/me', token).expect(200);

    expect(res.body).toMatchObject({
      type: UserType.SERVICE_ACCOUNT,
      email: null,
    });
  });

  it('rejects a token signed by a key that is not in the JWKS', async () => {
    const token = await idp.signToken({ signWithUntrustedKey: true });
    await get('/probe/me', token).expect(401);
  });

  it('rejects an expired token', async () => {
    const token = await idp.signToken({ expiresInSeconds: -60 });
    await get('/probe/me', token).expect(401);
  });

  it('rejects a token from another issuer', async () => {
    const token = await idp.signToken({
      issuer: 'http://evil.test/realms/orders',
    });
    await get('/probe/me', token).expect(401);
  });

  it('rejects a token issued for another audience', async () => {
    const token = await idp.signToken({ audience: 'another-api' });
    await get('/probe/me', token).expect(401);
  });

  it('rejects a validly signed token without sub', async () => {
    const token = await idp.signToken({ sub: null });
    await get('/probe/me', token).expect(401);
  });

  it('rejects an unsigned token (alg: none)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({
      sub: 'attacker',
      iss: FakeIdp.ISSUER,
      aud: FakeIdp.AUDIENCE,
      exp: now + 300,
      realm_access: { roles: ['ADMIN'] },
    })}.`;
    await get('/probe/me', token).expect(401);
  });

  it('rejects an HS256 token (algorithm confusion)', async () => {
    const token = await new SignJWT({ realm_access: { roles: ['ADMIN'] } })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('attacker')
      .setIssuer(FakeIdp.ISSUER)
      .setAudience(FakeIdp.AUDIENCE)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('a-secret-the-attacker-knows-000000'));
    await get('/probe/me', token).expect(401);
  });

  it('rejects a malformed Authorization header', async () => {
    const token = await idp.signToken();
    await request(t.app.getHttpServer())
      .get('/probe/me')
      .set('Authorization', `Token ${token}`)
      .expect(401);
  });
});
