import type {
  Conversation,
  ConversationUpdate,
  NewConversation,
} from '../entities/conversation.js';
import type { TenantRepository } from './tenant.repository.js';

export type ConversationRepository = TenantRepository<
  Conversation,
  NewConversation,
  ConversationUpdate
>;
