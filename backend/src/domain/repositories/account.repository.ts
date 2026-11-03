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
  /**
   * Cadastro público em uma única instrução atômica: cria a conta ainda não confirmada ou, se o
   * e-mail já existe **e continua sem confirmação**, substitui o hash da senha e a verificação
   * (o código anterior deixa de valer). Conta confirmada, desativada ou com envio feito depois de
   * `retryBefore` não muda. Devolve o id só quando algo foi gravado (e, portanto, um código deve
   * ser enviado); `null` é uniforme para "já confirmada" e "cedo demais".
   */
  registerUnverified(input: {
    readonly id: string;
    readonly email: string;
    readonly passwordHash: string;
    readonly verificationHash: string;
    readonly expiresAt: Date;
    readonly retryBefore: Date;
  }): Promise<string | null>;
  /** Novo código para conta não confirmada, respeitando o intervalo mínimo; sem trocar a senha. */
  refreshVerification(
    id: string,
    hash: string,
    expiresAt: Date,
    retryBefore: Date,
  ): Promise<boolean>;
  /** Descarta o código enviado que não chegou a sair (falha de envio), liberando novo envio já. */
  clearVerification(id: string, hash: string): Promise<void>;
  setVerification(id: string, hash: string, expiresAt: Date): Promise<void>;
  verify(id: string, hash: string, now: Date): Promise<boolean>;
  listMemberships(accountId: string): Promise<readonly AccountMembership[]>;
  membership(accountId: string, clientId: ClientId): Promise<AccountMembership | null>;
  createCompany(accountId: string, name: string): Promise<AccountMembership>;
}
