import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { UserType } from '../../users/user-type.enum';

/**
 * Local profile/cache of a Keycloak identity, upserted just-in-time from token
 * claims. Keycloak stays the source of truth: no password and no roles here.
 */
@Entity('users')
@Unique('uq_users_keycloak_sub', ['keycloakSub'])
export class User {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true })
  id: number;

  @Column({ name: 'keycloak_sub', type: 'char', length: 36 })
  keycloakSub: string;

  @Column({ type: 'varchar', length: 120 })
  username: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email: string | null;

  @Column({ type: 'enum', enum: UserType, default: UserType.USER })
  type: UserType;

  @Column({ name: 'first_seen_at', type: 'datetime', precision: 3 })
  firstSeenAt: Date;

  @Column({ name: 'last_seen_at', type: 'datetime', precision: 3 })
  lastSeenAt: Date;
}
