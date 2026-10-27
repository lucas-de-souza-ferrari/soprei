import type {
  Conversation,
  ConversationUpdate,
  NewConversation,
} from '../entities/conversation.js';
import type { ClientId } from '../value-objects/client-id.js';
import type { TenantRepository } from './tenant.repository.js';

export interface ConversationRepository extends TenantRepository<
  Conversation,
  NewConversation,
  ConversationUpdate
> {
  /**
   * A conversa deste contato (`contactRef`) neste cliente; cria se ainda não existe. Seguro
   * contra concorrência: dois pedidos simultâneos para o mesmo contato recebem a mesma
   * conversa (a unicidade `(clientId, contactRef)` é do banco).
   */
  findOrCreateByContact(clientId: ClientId, contactRef: string): Promise<Conversation>;
}
