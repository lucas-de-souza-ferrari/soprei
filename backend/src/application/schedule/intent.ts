import { SCHEDULE_INTENT_WORDS } from '../../domain/schedule.js';
import { KNOWLEDGE_QUERY_MAX_CHARS } from '../../domain/knowledge.js';
import { normalizeSearchText } from '../knowledge/normalize.js';
import { KNOWLEDGE_MIN_USEFUL_TERMS, usefulTermCount } from '../knowledge/query.js';

const INTENT: ReadonlySet<string> = new Set(SCHEDULE_INTENT_WORDS);

/**
 * O texto tem palavra de intenção de agenda (spec 027, E3)? Lista fixa e conservadora (sem acento,
 * palavra inteira): ficar de fora dela só faz a IA responder sem horários. Nunca loga o texto.
 */
export function hasScheduleIntent(text: string): boolean {
  const words = normalizeSearchText(text.slice(0, KNOWLEDGE_QUERY_MAX_CHARS)).split(/[^a-z0-9]+/);
  return words.some((word) => INTENT.has(word));
}

/**
 * Texto em que a intenção é procurada: o lote; se ele tem poucas palavras úteis ("e amanhã?"), junta o
 * último turno do contato do histórico (decisão 4 da 026).
 */
export function scheduleIntentText(batchText: string, lastUserTurn: string | undefined): string {
  const batch = batchText.slice(0, KNOWLEDGE_QUERY_MAX_CHARS);
  if (lastUserTurn !== undefined && usefulTermCount(batch) < KNOWLEDGE_MIN_USEFUL_TERMS) {
    return `${batch} ${lastUserTurn.slice(0, KNOWLEDGE_QUERY_MAX_CHARS)}`;
  }
  return batch;
}
