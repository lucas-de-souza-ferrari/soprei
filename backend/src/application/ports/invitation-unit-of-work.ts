import type {
  AccessStatus,
  AuditRepository,
  CompanyId,
  CompanyInvitationRepository,
  CompanyStatus,
  MembershipRole,
} from '../../domain/index.js';

/** O vínculo que age (ou que convidou), com papel e estado **do banco** (não do token). */
export interface InvitationActor {
  readonly id: string;
  readonly role: MembershipRole;
  readonly status: AccessStatus;
  /** Conta do vínculo; nulo nos vínculos do modo sem contas. Só serve à cota por conta convidadora. */
  readonly accountId: string | null;
}

/** O que o aceite precisa saber da conta (linha travada na transação). */
export interface InvitationAccount {
  readonly id: string;
  readonly email: string;
  readonly status: AccessStatus;
  readonly emailVerifiedAt: Date | null;
}

/**
 * Os repositórios e o SQL controlado de uma transação de convites (spec 025): convite, auditoria,
 * vínculo e conta mudam juntos ou não mudam. Ordem fixa de bloqueio: **empresa primeiro, conta
 * depois** (`createCompany` só trava conta: não há ciclo).
 */
export interface InvitationTransaction {
  readonly invitations: CompanyInvitationRepository;
  readonly audit: AuditRepository;
  /**
   * Trava a linha da empresa até o fim da transação (serializa criar, reenviar, revogar e aceitar).
   * Devolve estado e nome. `NotFoundError` se a empresa não existe ou foi removida.
   */
  lockCompany(
    companyId: CompanyId,
  ): Promise<{ readonly status: CompanyStatus; readonly name: string }>;
  /** O vínculo da empresa, relido; `null` se não existe nesta empresa. */
  actor(companyId: CompanyId, membershipId: string): Promise<InvitationActor | null>;
  /** Já há vínculo (ativo ou desativado) com este e-mail nesta empresa? */
  hasMemberWithEmail(companyId: CompanyId, email: string): Promise<boolean>;
  /** Esta conta já tem vínculo (qualquer estado) nesta empresa? */
  hasMembershipForAccount(companyId: CompanyId, accountId: string): Promise<boolean>;
  /** Trava e lê a conta pelo e-mail normalizado; `null` se não existe. */
  lockAccountByEmail(email: string): Promise<InvitationAccount | null>;
  /** Trava e lê a conta pelo id; `null` se não existe. */
  lockAccountById(id: string): Promise<InvitationAccount | null>;
  /**
   * Cria a conta já confirmada. `false` se o e-mail já existe (outra transação venceu): quem chama
   * relê com `lockAccountByEmail`.
   */
  createConfirmedAccount(input: {
    readonly id: string;
    readonly email: string;
    readonly passwordHash: string;
    readonly now: Date;
  }): Promise<boolean>;
  /**
   * Confirma uma conta **não confirmada e ativa** e SUBSTITUI a senha, limpando os códigos de
   * confirmação e de recuperação pendentes. `false` se ela deixou de estar nesse estado.
   */
  confirmUnverifiedAccount(id: string, passwordHash: string, now: Date): Promise<boolean>;
  /** Cria o vínculo da conta na empresa (`passwordHash` fixo `account-managed`). */
  createMembership(
    companyId: CompanyId,
    input: { readonly accountId: string; readonly email: string; readonly role: MembershipRole },
  ): Promise<{ readonly id: string }>;
}

/**
 * Executa `fn` numa única transação. Mantenha `fn` curta e **sem chamada externa** (hash de senha,
 * Redis, e-mail): a transação segura uma conexão do pool e o bloqueio da empresa.
 */
export interface InvitationUnitOfWork {
  run<T>(fn: (tx: InvitationTransaction) => Promise<T>): Promise<T>;
}
