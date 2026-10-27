import type { InboundNoticeReason } from '../ports/inbound-job-queue.js';

/**
 * Respostas constantes do canal para o que o atendimento não processa (spec 011, decisão 5):
 * nunca silêncio, nunca o LLM, nunca gravadas como mensagem.
 */
export const CHANNEL_NOTICE_TEXTS: Readonly<Record<InboundNoticeReason, string>> = {
  unsupported_type: 'No momento só consigo ler mensagens de texto.',
  invalid_text: 'Não consegui entender sua mensagem. Envie um texto de até 4000 caracteres.',
};
