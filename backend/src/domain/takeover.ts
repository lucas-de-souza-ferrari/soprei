/**
 * A equipe e a IA no mesmo chat (spec 039, D1). Quando a equipe responde o contato pelo aplicativo
 * WhatsApp Business (eco da coexistência), a IA para de responder aquele contato por este tempo,
 * renovado a cada nova resposta pelo celular. Constante de produto: sem variável de ambiente.
 */
export const AI_TAKEOVER_PAUSE_MINUTES = 12 * 60;

export const AI_TAKEOVER_PAUSE_MS = AI_TAKEOVER_PAUSE_MINUTES * 60 * 1000;

/**
 * Texto gravado no lugar de um eco que não é texto (foto, áudio, documento...): a mídia nunca é
 * baixada nem guardada (spec 039).
 */
export const HUMAN_MEDIA_PLACEHOLDER = '[mídia enviada pelo atendente]';

/** A IA está pausada neste contato no instante `now`? */
export function isAiPaused(aiPausedUntil: Date | null, now: Date): boolean {
  return aiPausedUntil !== null && aiPausedUntil.getTime() > now.getTime();
}
