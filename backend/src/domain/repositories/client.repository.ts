import type { Client, ClientUpdate, NewClient } from '../entities/client.js';
import type { ListOptions, Page } from '../pagination.js';
import type { ClientId } from '../value-objects/client-id.js';

/**
 * Repositório de `Client`, a raiz do tenant: não recebe `ClientId` de um cliente "dono".
 * Clientes removidos (soft delete) nunca aparecem, mas o slug deles continua reservado.
 */
export interface ClientRepository {
  /** Lança `NotFoundError` se não existe ou foi removido. */
  findById(id: ClientId): Promise<Client>;
  /** Lança `NotFoundError` se não existe ou foi removido. */
  findBySlug(slug: string): Promise<Client>;
  /**
   * O cliente dono deste `phone_number_id` do WhatsApp, ou `null` (número desconhecido ou cliente
   * removido). É o **único** ponto do sistema que sai de um identificador externo para o cliente:
   * o webhook resolve o `ClientId` aqui e dali em diante só o `ClientId` circula.
   */
  findByWhatsappPhoneNumberId(phoneNumberId: string): Promise<Client | null>;
  list(options?: ListOptions): Promise<Page<Client>>;
  /** Lança `ConflictError` se o slug já foi usado (inclusive por cliente removido). */
  create(data: NewClient): Promise<Client>;
  /** Lança `NotFoundError` se não existe ou foi removido. */
  update(id: ClientId, data: ClientUpdate): Promise<Client>;
  /** Soft delete. Lança `NotFoundError` se não existe ou já foi removido. */
  delete(id: ClientId): Promise<void>;
}
