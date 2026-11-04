import type {
  NewMembership,
  Membership,
  MembershipCredentials,
  MembershipUpdate,
} from '../entities/membership.js';
import type { CompanyId } from '../value-objects/company-id.js';
import type { TenantRepository } from './tenant.repository.js';

/**
 * Repositório de `Membership` (tenant). O `CompanyId` é o primeiro parâmetro de todo método; o e-mail é
 * único **por empresa** (`ConflictError` se repetido no mesma empresa).
 */
export interface MembershipRepository extends TenantRepository<
  Membership,
  NewMembership,
  MembershipUpdate
> {
  /**
   * Usuário e hash da senha pelo e-mail (já normalizado) nesta empresa, ou `null`. Único ponto
   * que devolve o hash; nunca consulta sem `CompanyId`.
   */
  findCredentialsByEmail(
    companyId: CompanyId,
    email: string,
  ): Promise<MembershipCredentials | null>;
  /** Usuário e hash da senha pelo id nesta empresa. Lança `NotFoundError` se não é desta empresa. */
  findCredentialsById(companyId: CompanyId, id: string): Promise<MembershipCredentials>;
  /** Quantos `OWNER` **ativos** a empresa tem (regra do último `OWNER`, spec 008). */
  countActiveOwners(companyId: CompanyId): Promise<number>;
  /** Troca o hash da senha. Lança `NotFoundError` se o usuário não é desta empresa. */
  updatePassword(companyId: CompanyId, id: string, passwordHash: string): Promise<void>;
}
