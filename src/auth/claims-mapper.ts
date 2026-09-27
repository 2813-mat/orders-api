import { UserType } from '../users/domain/user-type.enum';
import { AuthenticatedUser } from './authenticated-user';
import { Role } from './role.enum';

/** Subset of the Keycloak access token claims the API relies on. */
export interface KeycloakTokenClaims {
  sub?: string;
  preferred_username?: string;
  email?: string;
  azp?: string;
  realm_access?: { roles?: string[] };
  resource_access?: Record<string, { roles?: string[] }>;
}

export class InvalidTokenClaimsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTokenClaimsError';
  }
}

/** Keycloak names a client's service account user `service-account-<clientId>`. */
const SERVICE_ACCOUNT_PREFIX = 'service-account-';

const KNOWN_ROLES = new Set<string>(Object.values(Role));

function isRole(value: string): value is Role {
  return KNOWN_ROLES.has(value);
}

/**
 * Pure mapping from an already signature/issuer/audience-validated token to
 * the API user. Roles come from realm roles only (`realm_access.roles`).
 */
export function mapClaimsToUser(
  claims: KeycloakTokenClaims,
): AuthenticatedUser {
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
    throw new InvalidTokenClaimsError('Token has no subject (sub)');
  }

  const realmRoles = claims.realm_access?.roles ?? [];
  if (!Array.isArray(realmRoles)) {
    throw new InvalidTokenClaimsError('realm_access.roles must be an array');
  }

  const username = claims.preferred_username ?? claims.sub;

  return {
    sub: claims.sub,
    username,
    email: claims.email ?? null,
    roles: realmRoles.filter(isRole),
    type: username.startsWith(SERVICE_ACCOUNT_PREFIX)
      ? UserType.SERVICE_ACCOUNT
      : UserType.USER,
  };
}
