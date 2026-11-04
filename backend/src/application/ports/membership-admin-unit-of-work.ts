import type { AuditRepository, CompanyId, MembershipRepository } from '../../domain/index.js';

/** Os repositórios de uma transação da gestão de usuários: tudo confirma ou desfaz junto. */
export interface MembershipAdminTransaction {
  readonly memberships: MembershipRepository;
  readonly audit: AuditRepository;
  /**
   * Trava a linha da empresa (`SELECT ... FOR UPDATE`) até o fim da transação: serializa as
   * operações de gestão do mesma empresa (regra do último `OWNER`, spec 008). Chame **antes** de
   * ler o que a regra consulta. `NotFoundError` se a empresa não existe.
   */
  lockCompany(companyId: CompanyId): Promise<void>;
}

/**
 * Executa `fn` numa única transação do banco (mudança do usuário e evento de auditoria juntos).
 * Mantenha `fn` curta e **sem chamada externa** (hash de senha, Redis): a transação segura uma
 * conexão do pool e o bloqueio da empresa até terminar.
 */
export interface MembershipAdminUnitOfWork {
  run<T>(fn: (tx: MembershipAdminTransaction) => Promise<T>): Promise<T>;
}
