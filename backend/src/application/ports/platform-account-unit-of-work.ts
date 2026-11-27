import type {
  AccessStatus,
  AccountId,
  CompanyId,
  MembershipId,
  NewPlatformAuditEvent,
} from '../../domain/index.js';

/** O estado da conta relido sob a trava (spec 045, E2). Nunca o e-mail. */
export interface PlatformLockedAccount {
  readonly status: AccessStatus;
  readonly verified: boolean;
  /** Conta removida por anonimização (spec 045, E6): não volta a ser reativada. */
  readonly anonymized?: boolean;
}

/** Um vínculo da conta, para revogar as sessões Bearer dele depois do commit. */
export interface PlatformAccountMembershipRef {
  readonly companyId: CompanyId;
  readonly membershipId: MembershipId;
}

/**
 * Transação das ações do admin da plataforma sobre uma conta (spec 045, E2, regra comum 4). A ordem das
 * travas é sempre **empresa antes de conta** (como o aceite da 025 e a E3): `lockOwnedCompanies` trava,
 * em ordem de id, as empresas não removidas em que a conta tem vínculo `OWNER` ativo; `lockAccount`
 * trava a linha da conta (`FOR NO KEY UPDATE`). O callback não faz chamada externa (Redis, e-mail).
 */
export interface PlatformAccountTransaction {
  /**
   * Trava as empresas (não removidas) em que a conta tem vínculo `OWNER` ativo, em ordem de id, e
   * devolve quantas travou. Chamar de novo depois de `lockAccount` trava as que surgiram no meio (uma
   * promoção já confirmada), sem inverter a ordem para quem segue empresa -> conta.
   */
  lockOwnedCompanies(accountId: AccountId): Promise<number>;
  /** Trava a conta e devolve o estado atual. Inexistente: `NotFoundError`. */
  lockAccount(accountId: AccountId): Promise<PlatformLockedAccount>;
  /**
   * Quantas empresas **ativas e não removidas** têm esta conta como **único** dono ativo (regra comum 11:
   * vínculo `OWNER` `ACTIVE` com a conta `ACTIVE`, ou sem conta). O mesmo SQL do "dono ativo" da E1.
   */
  soleActiveOwnerCompanies(accountId: AccountId): Promise<number>;
  setStatus(accountId: AccountId, status: AccessStatus): Promise<void>;
  /** Todos os vínculos da conta, em qualquer empresa e estado (para revogar as sessões Bearer). */
  memberships(accountId: AccountId): Promise<readonly PlatformAccountMembershipRef[]>;
  audit(event: NewPlatformAuditEvent): Promise<void>;
}

export interface PlatformAccountUnitOfWork {
  run<T>(fn: (tx: PlatformAccountTransaction) => Promise<T>): Promise<T>;
}
