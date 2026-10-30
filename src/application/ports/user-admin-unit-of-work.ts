import type { AuditRepository, ClientId, UserRepository } from '../../domain/index.js';

/** Os repositórios de uma transação da gestão de usuários: tudo confirma ou desfaz junto. */
export interface UserAdminTransaction {
  readonly users: UserRepository;
  readonly audit: AuditRepository;
  /**
   * Trava a linha do cliente (`SELECT ... FOR UPDATE`) até o fim da transação: serializa as
   * operações de gestão do mesmo cliente (regra do último `OWNER`, spec 008). Chame **antes** de
   * ler o que a regra consulta. `NotFoundError` se o cliente não existe.
   */
  lockClient(clientId: ClientId): Promise<void>;
}

/**
 * Executa `fn` numa única transação do banco (mudança do usuário e evento de auditoria juntos).
 * Mantenha `fn` curta e **sem chamada externa** (hash de senha, Redis): a transação segura uma
 * conexão do pool e o bloqueio do cliente até terminar.
 */
export interface UserAdminUnitOfWork {
  run<T>(fn: (tx: UserAdminTransaction) => Promise<T>): Promise<T>;
}
