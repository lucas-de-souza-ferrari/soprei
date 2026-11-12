import type { WithoutCompanyId } from '../repositories/tenant.repository.js';
import type { CompanyId } from '../value-objects/company-id.js';

/** Limite de caracteres do `contactRef`. */
export const CONTACT_REF_MAX_LENGTH = 128;

/**
 * Conversa de um contato com o assistente de uma empresa. `contactRef` é o identificador do
 * contato definido pelo canal (texto livre); há uma conversa por (empresa, contactRef).
 */
export interface Conversation {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly contactRef: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** Spec 039: a IA não responde este contato até este instante (a equipe respondeu pelo celular). */
  readonly aiPausedUntil: Date | null;
  /**
   * Spec 039: mensagens do contato com `createdAt` até este instante foram tratadas pela equipe e
   * nunca são respondidas pela IA (saem das pendentes).
   */
  readonly aiIgnoreBefore: Date | null;
}

/** Mudança da pausa da IA (spec 039): cada campo só avança, nunca volta. */
export interface AiPauseExtension {
  readonly pausedUntil?: Date;
  readonly ignoreBefore?: Date;
}

/** Dados de criação. Não há `companyId` aqui: ele vem sempre do parâmetro do repositório. */
export interface NewConversation extends WithoutCompanyId {
  readonly contactRef: string;
}

/** Dados de atualização (ainda sem campos editáveis). */
export type ConversationUpdate = Readonly<Record<string, never>>;
