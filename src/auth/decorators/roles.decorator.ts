import { SetMetadata } from '@nestjs/common';
import { Role } from '../role.enum';

export const ROLES_KEY = 'roles';

/**
 * Restricts a route (or controller) to users holding at least one of the given
 * realm roles. A handler-level @Roles overrides the controller-level one.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
