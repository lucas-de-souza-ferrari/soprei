import type {
  AccessStatus,
  CompanyId,
  CompanyStatus,
  MembershipId,
  MembershipRole,
  NewPlatformAuditEvent,
} from '../../domain/index.js';

/** A empresa relida sob a trava (spec 045, E3a). Nunca a persona nem dado de conteúdo. */
export interface PlatformLockedCompany {
  readonly status: CompanyStatus;
  readonly name: string;
  readonly slug: string;
}

/** A empresa lida sem trava, em qualquer estado, inclusive removida (pré-checagem e restauração). */
export interface PlatformCompanyState {
  readonly slug: string;
  readonly removed: boolean;
}

/**
 * A conexão do canal apagada com a empresa (spec 045, E3a): o suficiente para desassinar o app da WABA
 * depois do commit, em melhor esforço. O token continua cifrado; só o serviço do canal o decifra.
 */
export interface PlatformRemovedChannel {
  readonly wabaId: string;
  readonly tokenCiphertext: string;
}

/** Um vínculo relido sob a trava da empresa, com o estado da conta (regra comum 11). Nunca o e-mail. */
export interface PlatformLockedMembership {
  readonly role: MembershipRole;
  readonly status: AccessStatus;
  /** `null`: vínculo antigo da CLI, sem conta. */
  readonly account: { readonly status: AccessStatus; readonly verified: boolean } | null;
}

/**
 * Transação das ações do admin da plataforma sobre uma empresa (spec 044, E2, D1; spec 045, E3a): trava a
 * linha da empresa (a mesma trava da gestão de usuários, `FOR NO KEY UPDATE`), relê, grava e escreve o
 * evento da trilha juntos. O callback não faz chamada externa (Redis, Meta, e-mail).
 */
export interface PlatformCompanyTransaction {
  /** Trava a empresa e devolve o estado atual. Inexistente ou removida: `NotFoundError`. */
  lockCompany(companyId: CompanyId): Promise<CompanyStatus>;
  /** Depois de `lockCompany`: nome, slug e estado. */
  company(companyId: CompanyId): Promise<PlatformLockedCompany>;
  setStatus(companyId: CompanyId, status: CompanyStatus): Promise<void>;
  rename(companyId: CompanyId, name: string): Promise<void>;
  /**
   * Soft delete (o mesmo do `CompanyRepository.delete`: `deletedAt`, número liberado, conexão do canal
   * apagada) e os convites pendentes revogados, tudo nesta transação. Devolve a conexão apagada (para a
   * desassinatura depois do commit) ou `null` se não havia conexão.
   */
  remove(companyId: CompanyId, now: Date): Promise<PlatformRemovedChannel | null>;
  /** Estado da empresa em qualquer situação, sem trava; `null` se não existe. */
  state(companyId: CompanyId): Promise<PlatformCompanyState | null>;
  /**
   * Limpa o `deletedAt` só se a empresa ainda estiver removida (o próprio UPDATE serializa duas
   * restaurações). Devolve se restaurou.
   */
  restore(companyId: CompanyId): Promise<boolean>;
  /** O vínculo procurado PELO PAR (empresa, id); de outra empresa ou inexistente: `null`. */
  membership(
    companyId: CompanyId,
    membershipId: MembershipId,
  ): Promise<PlatformLockedMembership | null>;
  setMembershipRole(
    companyId: CompanyId,
    membershipId: MembershipId,
    role: MembershipRole,
  ): Promise<void>;
  setMembershipStatus(
    companyId: CompanyId,
    membershipId: MembershipId,
    status: AccessStatus,
  ): Promise<void>;
  /** Quantos donos ativos a empresa tem (regra comum 11: o mesmo SQL do "dono ativo" da E1 e da E2). */
  activeOwners(companyId: CompanyId): Promise<number>;
  audit(event: NewPlatformAuditEvent): Promise<void>;
}

export interface PlatformCompanyUnitOfWork {
  run<T>(fn: (tx: PlatformCompanyTransaction) => Promise<T>): Promise<T>;
}
