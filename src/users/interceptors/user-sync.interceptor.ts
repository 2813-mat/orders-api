import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Request } from 'express';
import { Observable } from 'rxjs';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { UsersService } from '../services/users.service';

/**
 * Runs after the global guards, so `request.user` is a validated token.
 * The local profile is a cache: if writing it fails, the request goes on.
 */
@Injectable()
export class UserSyncInterceptor implements NestInterceptor {
  private readonly logger = new Logger(UserSyncInterceptor.name);

  constructor(private readonly users: UsersService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const { user } = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();

    if (user) {
      try {
        await this.users.syncFromToken(user);
      } catch (error) {
        this.logger.warn(
          `Could not sync local profile for sub ${user.sub}: ${String(error)}`,
        );
      }
    }
    return next.handle();
  }
}
