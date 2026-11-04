import type {
  Conversation,
  ConversationUpdate,
  NewConversation,
} from '../entities/conversation.js';
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
}
