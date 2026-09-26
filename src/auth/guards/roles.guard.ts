import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AuthenticatedUser } from '../authenticated-user';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { Role } from '../role.enum';

/**
 * Runs after JwtAuthGuard (registration order in AuthModule), so an anonymous
 * request is already 401 by the time roles are checked: 403 only means
 * "authenticated, but not allowed".
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required?.length) {
      return true;
    }

    const { user } = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();
    if (!user?.roles.some((role) => required.includes(role))) {
      throw new ForbiddenException(
        `Requires one of the roles: ${required.join(', ')}`,
      );
    }
    return true;
  }
}
