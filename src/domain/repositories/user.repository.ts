import type { NewUser, User, UserCredentials, UserUpdate } from '../entities/user.js';
import type { ClientId } from '../value-objects/client-id.js';
import type { TenantRepository } from './tenant.repository.js';

/**
 * Repositório de `User` (tenant). O `ClientId` é o primeiro parâmetro de todo método; o e-mail é
 * único **por cliente** (`ConflictError` se repetido no mesmo cliente).
 */
export interface UserRepository extends TenantRepository<User, NewUser, UserUpdate> {
  /**
   * Usuário e hash da senha pelo e-mail (já normalizado) neste cliente, ou `null`. Único ponto
   * que devolve o hash; nunca consulta sem `ClientId`.
   */
  findCredentialsByEmail(clientId: ClientId, email: string): Promise<UserCredentials | null>;
  /** Usuário e hash da senha pelo id neste cliente. Lança `NotFoundError` se não é deste cliente. */
  findCredentialsById(clientId: ClientId, id: string): Promise<UserCredentials>;
  /** Quantos `OWNER` **ativos** o cliente tem (regra do último `OWNER`, spec 008). */
  countActiveOwners(clientId: ClientId): Promise<number>;
  /** Troca o hash da senha. Lança `NotFoundError` se o usuário não é deste cliente. */
  updatePassword(clientId: ClientId, id: string, passwordHash: string): Promise<void>;
}
