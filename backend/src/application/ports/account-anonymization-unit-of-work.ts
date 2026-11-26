import type {
  AccessStatus,
  AccountId,
  CompanyId,
  MembershipId,
  NewPlatformAuditEvent,
} from '../../domain/index.js';

/** A conta relida sob a trava: o e-mail só para o aviso, lido ANTES de anonimizar. */
export interface AnonymizableAccount {
  readonly email: string;
  readonly status: AccessStatus;
}

/** Um vínculo da conta, para revogar as sessões Bearer dele depois do commit. */
export interface AnonymizedMembershipRef {
  readonly companyId: CompanyId;
  readonly membershipId: MembershipId;
}

/**
 * Transação da anonimização de uma conta (spec 032, E7; spec 045, E6). Travas na ordem **empresas em que a
 * conta é dona -> conta** (a mesma das ações da plataforma). O callback não faz chamada externa.
 */
export interface AccountAnonymizationTransaction {
  lockOwnedCompanies(accountId: AccountId): Promise<number>;
  /** Trava e relê a conta; `null` se não existe. */
  lockAccount(accountId: AccountId): Promise<AnonymizableAccount | null>;
  /**
   * Empresas **não removidas** (de qualquer estado) em que a conta é o único dono ativo (regra comum 11): o
   * mesmo SQL do "dono ativo" da E1. Mais que zero = 409 `COMPANY_OWNERSHIP`.
   */
  soleOwnerCompanies(accountId: AccountId): Promise<number>;
  /** Há período pago em vigor sem `cancelAtPeriodEnd`? Sim = 409 `SUBSCRIPTION_ACTIVE`. */
  paidInForce(accountId: AccountId, now: Date): Promise<boolean>;
  /**
   * Anonimiza a conta (e-mail \`anonymizedEmail\`, senha inválida fixa, `DISABLED`, última empresa, códigos e
   * contadores nulos ou zerados) e os vínculos dela (o mesmo e-mail anonimizado, `DISABLED`). Devolve os
   * vínculos. A linha continua existindo (a trilha, a assinatura e os pedidos apontam para ela).
   */
  anonymize(
    accountId: AccountId,
    anonymizedEmail: string,
  ): Promise<readonly AnonymizedMembershipRef[]>;
  /** Os vínculos da conta, em qualquer empresa e estado (a repetição refaz a revogação). */
  memberships(accountId: AccountId): Promise<readonly AnonymizedMembershipRef[]>;
  platformAudit(event: NewPlatformAuditEvent): Promise<void>;
}

export interface AccountAnonymizationUnitOfWork {
  run<T>(fn: (tx: AccountAnonymizationTransaction) => Promise<T>): Promise<T>;
}
