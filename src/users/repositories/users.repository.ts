import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { User } from '../../database/entities/user.entity';

export type UserProfile = Pick<
  User,
  'keycloakSub' | 'username' | 'email' | 'type'
>;

@Injectable()
export class UsersRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * INSERT ... ON DUPLICATE KEY UPDATE in a single statement, so concurrent
   * first requests for the same sub can't race into a duplicate: the
   * UNIQUE(keycloak_sub) turns the loser into an update. `first_seen_at` is
   * only written on insert.
   */
  async upsertProfile(profile: UserProfile, seenAt: Date): Promise<void> {
    await this.dataSource
      .createQueryBuilder()
      .insert()
      .into(User)
      .values({ ...profile, firstSeenAt: seenAt, lastSeenAt: seenAt })
      .orUpdate(['username', 'email', 'type', 'last_seen_at'])
      .updateEntity(false)
      .execute();
  }
}
