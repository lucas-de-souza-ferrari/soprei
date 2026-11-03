import type { ClientId } from '../value-objects/client-id.js';
import type { UserId } from '../value-objects/user-id.js';
import type { AccountId } from '../value-objects/user-id.js';
import type { UserRole } from '../entities/user.js';

export interface Account {
  readonly id: AccountId;
  readonly email: string;
  readonly passwordHash: string;
  readonly status: 'ACTIVE' | 'DISABLED';
  readonly emailVerifiedAt: Date | null;
}

export interface AccountMembership {
  readonly clientId: ClientId;
  readonly userId: UserId;
  readonly name: string;
  readonly role: UserRole;
}

/** Única resolução de conta global para empresas; não devolve dados de negócio. */
export interface AccountRepository {
  findByEmail(email: string): Promise<Account | null>;
  findById(id: AccountId): Promise<Account | null>;
  create(email: string, passwordHash: string): Promise<Account>;
  setVerification(id: string, hash: string, expiresAt: Date): Promise<void>;
  verify(id: string, hash: string, now: Date): Promise<boolean>;
  listMemberships(accountId: string): Promise<readonly AccountMembership[]>;
  membership(accountId: string, clientId: ClientId): Promise<AccountMembership | null>;
  createCompany(accountId: string, name: string): Promise<AccountMembership>;
}
