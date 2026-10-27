import type { ConversationRepository } from './conversation.repository.js';
import type { MessageRepository } from './message.repository.js';

/** Os repositórios de uma transação do banco: tudo o que passa por eles confirma ou desfaz junto. */
export interface AttendanceTransaction {
  readonly conversations: ConversationRepository;
  readonly messages: MessageRepository;
}

/**
 * Executa `fn` numa única transação. Mantenha `fn` curta e **sem chamada externa** (LLM,
 * rede): a transação segura uma conexão do pool até terminar.
 */
export interface AttendanceUnitOfWork {
  run<T>(fn: (tx: AttendanceTransaction) => Promise<T>): Promise<T>;
}
