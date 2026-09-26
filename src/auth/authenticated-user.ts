import { UserType } from '../users/user-type.enum';
import { Role } from './role.enum';

/** What the API knows about the caller, derived only from a validated token. */
export interface AuthenticatedUser {
  sub: string;
  username: string;
  email: string | null;
  roles: Role[];
  type: UserType;
}
