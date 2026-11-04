import type { Company, CompanyUpdate, NewCompany } from '../entities/company.js';
import type { ListOptions, Page } from '../pagination.js';
import type { CompanyId } from '../value-objects/company-id.js';

/**
 * Repositório de `Company`, a raiz do tenant: não recebe `CompanyId` de uma empresa "dono".
 * Empresas removidas (soft delete) nunca aparecem, mas o slug deles continua reservado.
 */
export interface CompanyRepository {
  /** Lança `NotFoundError` se não existe ou foi removido. */
  findById(id: CompanyId): Promise<Company>;
  /** Lança `NotFoundError` se não existe ou foi removido. */
  findBySlug(slug: string): Promise<Company>;
  /**
   * A empresa dona deste `phone_number_id` do WhatsApp, ou `null` (número desconhecido ou empresa
   * removido). É o **único** ponto do sistema que sai de um identificador externo para a empresa:
   * o webhook resolve o `CompanyId` aqui e dali em diante só o `CompanyId` circula.
   */
  findByWhatsappPhoneNumberId(phoneNumberId: string): Promise<Company | null>;
  list(options?: ListOptions): Promise<Page<Company>>;
  /** Lança `ConflictError` se o slug já foi usado (inclusive por empresa removida). */
  create(data: NewCompany): Promise<Company>;
  /** Lança `NotFoundError` se não existe ou foi removido. */
  update(id: CompanyId, data: CompanyUpdate): Promise<Company>;
  /** Soft delete. Lança `NotFoundError` se não existe ou já foi removido. */
  delete(id: CompanyId): Promise<void>;
}
