import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { passportJwtSecret } from 'jwks-rsa';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { EnvironmentVariables } from '../config/env.validation';
import { AuthenticatedUser } from './authenticated-user';
import {
  InvalidTokenClaimsError,
  KeycloakTokenClaims,
  mapClaimsToUser,
} from './claims-mapper';

/**
 * The API is a resource server: it never issues tokens, it only verifies the
 * ones Keycloak signs. Signature keys come from the JWKS endpoint (internal
 * URL) and are cached, so a Keycloak outage doesn't break tokens already issued.
 * The issuer is checked against the public URL that appears in the token.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService<EnvironmentVariables, true>) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKeyProvider: passportJwtSecret({
        jwksUri: config.get('KEYCLOAK_JWKS_URI', { infer: true }),
        cache: true,
        cacheMaxAge: 10 * 60_000,
        rateLimit: true,
        jwksRequestsPerMinute: 10,
      }),
      issuer: config.get('KEYCLOAK_ISSUER', { infer: true }),
      audience: config.get('KEYCLOAK_AUDIENCE', { infer: true }),
      // Only asymmetric signatures: rejects `alg: none` and HS256 key-confusion tokens.
      algorithms: ['RS256'],
    });
  }

  validate(payload: KeycloakTokenClaims): AuthenticatedUser {
    try {
      return mapClaimsToUser(payload);
    } catch (error) {
      if (error instanceof InvalidTokenClaimsError) {
        throw new UnauthorizedException(error.message);
      }
      throw error;
    }
  }
}
