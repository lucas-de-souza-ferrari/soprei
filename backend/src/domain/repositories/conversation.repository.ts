import type {
  Conversation,
  ConversationUpdate,
  NewConversation,
} from '../entities/conversation.js';
import type { ListOptions, Page } from '../pagination.js';
import type { CompanyId } from '../value-objects/company-id.js';
import type { TenantRepository } from './tenant.repository.js';

export interface ConversationRepository extends TenantRepository<
  Conversation,
  NewConversation,
  ConversationUpdate
> {
  /**
   * A conversa deste contato (`contactRef`) nesta empresa; cria se ainda não existe. Seguro
   * contra concorrência: dois pedidos simultâneos para o mesmo contato recebem a mesma
   * conversa (a unicidade `(companyId, contactRef)` é do banco).
   */
  findOrCreateByContact(companyId: CompanyId, contactRef: string): Promise<Conversation>;
  /** A conversa deste contato nesta empresa, ou `null` se ainda não existe (nunca cria). */
  findByContact(companyId: CompanyId, contactRef: string): Promise<Conversation | null>;
  /**
   * Conversas da empresa por **última atividade**, a mais recente primeiro (`updatedAt` e `id`
   * decrescentes; spec 024). `updatedAt` é tocado quando uma mensagem é gravada na conversa.
   */
  listByActivity(companyId: CompanyId, options?: ListOptions): Promise<Page<Conversation>>;
  /**
   * Conversas da empresa com estes ids, em lote (spec 030; sem N+1). Ids malformados ou de outra
   * empresa simplesmente não aparecem.
   */
  findByIds(companyId: CompanyId, ids: readonly string[]): Promise<Conversation[]>;
}
