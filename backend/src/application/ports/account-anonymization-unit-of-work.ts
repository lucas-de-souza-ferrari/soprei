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
  /** E-mail confirmado: só então o aviso "conta excluída" sai (endereço comprovado). */
  readonly verified: boolean;
}

/** Um vínculo da conta, para revogar as sessões Bearer dele depois do commit. */
export interface AnonymizedMembershipRef {
  readonly companyId: CompanyId;
  readonly membershipId: MembershipId;
}

/**
 * Transação da anonimização de uma conta (spec 032, E7; spec 045, E6). Travas na ordem **empresas em que a
 * conta tem vínculo -> conta** (a mesma das ações da plataforma). O callback não faz chamada externa.
 */
export interface AccountAnonymizationTransaction {
  /**
   * Trava, em ordem de id, **todas** as empresas não removidas em que a conta tem vínculo (qualquer papel e
   * estado), não só as que ela já possui: uma promoção a `OWNER` em curso não escapa da regra do dono.
   */
  lockMemberCompanies(accountId: AccountId): Promise<number>;
  /** Trava e relê a conta; `null` se não existe. */
  lockAccount(accountId: AccountId): Promise<AnonymizableAccount | null>;
  /**
   * Empresas **não removidas** (de qualquer estado) em que a conta tem vínculo `OWNER` ativo e não há
   * **outro** dono ativo (regra comum 11), qualquer que seja o estado da conta. Mais que zero = 409
   * `COMPANY_OWNERSHIP`.
   */
  soleOwnerCompanies(accountId: AccountId): Promise<number>;
  /** Há período pago em vigor sem `cancelAtPeriodEnd`? Sim = 409 `SUBSCRIPTION_ACTIVE`. */
  paidInForce(accountId: AccountId, now: Date): Promise<boolean>;
  /**
   * Anonimiza a conta (e-mail `anonymizedEmail`, senha inválida fixa, `DISABLED`, última empresa, códigos e
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
