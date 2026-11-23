/**
 * Retomada do atendimento (spec 035): limites da varredura que reagenda o que ficou sem resposta no
 * canal. Constantes de produto, decididas pelo dono em 2026-11-23 (D1 a D3): sem variável de ambiente.
 */

/** Idade mínima da mensagem pendente (ou da resposta não enviada) para a varredura agir: 5 minutos. */
export const RESUME_MIN_AGE_MS = 5 * 60 * 1000;

/**
 * Janela de retomada: 23 horas desde a última mensagem do contato. A Meta só aceita texto livre por
 * 24 horas depois da última mensagem do contato; a hora de margem evita o envio recusado no limite.
 */
export const RESUME_WINDOW_MS = 23 * 60 * 60 * 1000;

/** Retomadas por contato a cada `RESUME_ATTEMPT_WINDOW_MS`; estourado, só uma mensagem nova destrava. */
export const RESUME_MAX_ATTEMPTS = 3;

export const RESUME_ATTEMPT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Contatos agendados por execução da varredura (o resto fica para a seguinte). */
export const RESUME_MAX_CONTACTS_PER_RUN = 200;

/** Empresas lidas por execução, em rodízio (a seguinte continua de onde esta parou). */
export const RESUME_MAX_COMPANIES_PER_RUN = 50;

/** Contatos lidos por empresa e por tipo em cada execução. */
export const RESUME_MAX_CONTACTS_PER_COMPANY = 50;

/** Jobs apagados por estado em cada limpeza da fila (spec 035, E3). */
export const QUEUE_CLEAN_BATCH = 1000;

/**
 * A resposta gravada e ainda sem `sentAt` pode ser reenviada agora? Não, se a equipe assumiu a
 * conversa depois dela (spec 039: `aiIgnoreBefore` igual ou posterior à resposta, que foi segurada de
 * propósito), se ela saiu da janela de retomada ou se é o texto padrão de falha (`isFallback`: repeti-lo
 * minutos ou horas depois iria contra a D4).
 */
export function isReplyResendable(
  reply: { readonly createdAt: Date; readonly isFallback?: boolean },
  conversation: { readonly aiIgnoreBefore: Date | null },
  now: Date,
): boolean {
  if (reply.isFallback === true) return false;
  const created = reply.createdAt.getTime();
  if (conversation.aiIgnoreBefore !== null && created <= conversation.aiIgnoreBefore.getTime()) {
    return false;
  }
  return now.getTime() - created < RESUME_WINDOW_MS;
}
