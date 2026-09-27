import { randomUUID } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';

export interface TokenOptions {
  /** `null` omits the claim. */
  sub?: string | null;
  username?: string;
  email?: string;
  roles?: string[];
  issuer?: string;
  audience?: string | string[];
  /** Seconds from now; negative produces an already expired token. */
  expiresInSeconds?: number;
  /** Signs with a key that is NOT published in the JWKS (same kid). */
  signWithUntrustedKey?: boolean;
  /** Extra/overriding claims, e.g. to drop `sub`. */
  claims?: Record<string, unknown>;
}

/**
 * Minimal stand-in for Keycloak in tests: an RSA key pair, a local HTTP server
 * publishing the JWKS, and tokens with the same claim layout Keycloak emits.
 * The real JwtStrategy/guards run against it; nothing on the API side is mocked.
 */
export class FakeIdp {
  static readonly ISSUER = 'http://fake-idp.test/realms/orders';
  static readonly AUDIENCE = 'orders-api';
  static readonly CLIENT_ID = 'orders-api';

  private constructor(
    private readonly server: Server,
    private readonly kid: string,
    private readonly trustedKey: CryptoKey,
    private readonly untrustedKey: CryptoKey,
    readonly jwksUri: string,
  ) {}

  /** `port` 0 picks a free one; e2e uses a fixed port known before boot. */
  static async start(port = 0): Promise<FakeIdp> {
    const trusted = await generateKeyPair('RS256');
    const untrusted = await generateKeyPair('RS256');
    const kid = randomUUID();

    const publicJwk = {
      ...(await exportJWK(trusted.publicKey)),
      kid,
      alg: 'RS256',
      use: 'sig',
    };
    const server = createServer((req, res) => {
      if (req.url?.endsWith('/protocol/openid-connect/certs')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ keys: [publicJwk] }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) =>
      server.listen(port, '127.0.0.1', resolve),
    );
    const { port: boundPort } = server.address() as AddressInfo;

    return new FakeIdp(
      server,
      kid,
      trusted.privateKey,
      untrusted.privateKey,
      `http://127.0.0.1:${boundPort}/realms/orders/protocol/openid-connect/certs`,
    );
  }

  /** Env the API needs to trust this IdP. */
  get env() {
    return {
      KEYCLOAK_ISSUER: FakeIdp.ISSUER,
      KEYCLOAK_JWKS_URI: this.jwksUri,
      KEYCLOAK_AUDIENCE: FakeIdp.AUDIENCE,
      KEYCLOAK_CLIENT_ID: FakeIdp.CLIENT_ID,
    };
  }

  async signToken(options: TokenOptions = {}): Promise<string> {
    const username = options.username ?? 'user';
    const now = Math.floor(Date.now() / 1000);

    const sub = options.sub === undefined ? randomUUID() : options.sub;

    return new SignJWT({
      typ: 'Bearer',
      azp: FakeIdp.CLIENT_ID,
      scope: 'profile email',
      preferred_username: username,
      ...(sub !== null && { sub }),
      ...(options.email !== undefined && { email: options.email }),
      realm_access: { roles: options.roles ?? ['USER'] },
      ...options.claims,
    })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: this.kid })
      .setIssuer(options.issuer ?? FakeIdp.ISSUER)
      .setAudience(options.audience ?? FakeIdp.AUDIENCE)
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + (options.expiresInSeconds ?? 300))
      .sign(options.signWithUntrustedKey ? this.untrustedKey : this.trustedKey);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}
