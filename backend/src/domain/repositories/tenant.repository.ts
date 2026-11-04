import type { ListOptions, Page } from '../pagination.js';
import type { CompanyId } from '../value-objects/company-id.js';

/** Os tipos de criação e de atualização nunca carregam `companyId`: ele vem do parâmetro. */
export interface WithoutCompanyId {
  readonly companyId?: never;
}

/**
 * Repositório de uma entidade que pertence a uma empresa. O `CompanyId` é o **primeiro
 * parâmetro de todo método**: não existe como consultar sem informar a empresa, e um id
 * de outra empresa se comporta como inexistente (`NotFoundError`).
 *
 * A ordem da listagem é estável: `createdAt` e depois `id`, ambos crescentes.
 */
export interface TenantRepository<
  T,
  TCreate extends WithoutCompanyId,
  TUpdate extends WithoutCompanyId,
> {
  /** Lança `NotFoundError` se o id não existe nesta empresa. */
  findById(companyId: CompanyId, id: string): Promise<T>;
  list(companyId: CompanyId, options?: ListOptions): Promise<Page<T>>;
  create(companyId: CompanyId, data: TCreate): Promise<T>;
  /** Lança `NotFoundError` se o id não existe nesta empresa. */
  update(companyId: CompanyId, id: string, data: TUpdate): Promise<T>;
  /** Lança `NotFoundError` se o id não existe nesta empresa. */
  delete(companyId: CompanyId, id: string): Promise<void>;
  count(companyId: CompanyId): Promise<number>;
}
