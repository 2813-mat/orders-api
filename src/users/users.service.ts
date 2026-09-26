import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { EnvironmentVariables } from '../config/env.validation';
import { User } from './user.entity';

/** Bounds the in-memory throttle map; the oldest entries are dropped first. */
const MAX_TRACKED_SUBS = 10_000;

/**
 * Keeps a local profile of Keycloak identities (just-in-time, from token
 * claims). Keycloak stays the source of truth; this table is a cache for
 * display/reporting, never used for authentication or authorization.
 */
@Injectable()
export class UsersService {
  private readonly syncIntervalMs: number;
  private readonly lastSyncedAt = new Map<string, number>();

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.syncIntervalMs = config.get('USER_SYNC_INTERVAL_MS', { infer: true });
  }

  /**
   * Upserts the caller's profile, at most once per interval per sub and per
   * process. Returns whether a write happened.
   */
  async syncFromToken(user: AuthenticatedUser): Promise<boolean> {
    const now = Date.now();
    const last = this.lastSyncedAt.get(user.sub);
    if (last !== undefined && now - last < this.syncIntervalMs) {
      return false;
    }

    const seenAt = new Date(now);
    // Single statement, so concurrent first requests for the same sub can't
    // race into a duplicate: the UNIQUE(keycloak_sub) turns the loser into an update.
    await this.users
      .createQueryBuilder()
      .insert()
      .into(User)
      .values({
        keycloakSub: user.sub,
        username: user.username,
        email: user.email,
        type: user.type,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
      })
      .orUpdate(['username', 'email', 'type', 'last_seen_at'])
      .updateEntity(false)
      .execute();

    this.remember(user.sub, now);
    return true;
  }

  private remember(sub: string, at: number): void {
    this.lastSyncedAt.delete(sub);
    this.lastSyncedAt.set(sub, at);
    if (this.lastSyncedAt.size > MAX_TRACKED_SUBS) {
      const [oldest] = this.lastSyncedAt.keys();
      this.lastSyncedAt.delete(oldest);
    }
  }
}
