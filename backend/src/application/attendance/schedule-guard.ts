import { SCHEDULE_AI_CLAIM_PHRASES, SCHEDULE_AI_SAFE_REPLY } from '../../domain/index.js';
import { normalizeSearchText } from '../knowledge/normalize.js';
import type { ScheduleWriteRecord } from './schedule-tools.js';

/**
 * Guarda de afirmação (spec 028, decisão 7): a resposta diz, em primeira pessoa, que marcou, agendou,
 * reservou, cancelou ou remarcou? Lista fixa de frases, sem acento. "não marquei" (negação logo antes) não
 * é afirmação. Falso positivo é aceito: o texto seguro nunca promete nada.
 */
export function claimsDone(text: string): boolean {
  const normalized = ` ${normalizeSearchText(text)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
  return SCHEDULE_AI_CLAIM_PHRASES.some(
    (phrase) => normalized.includes(` ${phrase} `) && !normalized.includes(` nao ${phrase} `),
  );
}

export type ScheduleReplyKind = 'as_is' | 'guard_replaced' | 'deterministic_summary';

/**
 * Decide o texto final de um turno com ferramentas de escrita, **só com o que o servidor gravou**:
 * - sem escrita confirmada e com afirmação de conclusão: troca pelo texto seguro;
 * - com escrita confirmada e sem a hora gravada no texto do modelo: acrescenta o resumo determinístico.
 * `maxLength` é o teto da mensagem; se o texto mais o resumo não cabe, fica só o resumo.
 */
export function finalizeScheduleReply(
  text: string,
  writes: readonly ScheduleWriteRecord[],
  maxLength: number,
): { readonly text: string; readonly kind: ScheduleReplyKind } {
  if (writes.length === 0) {
    return claimsDone(text)
      ? { text: SCHEDULE_AI_SAFE_REPLY, kind: 'guard_replaced' }
      : { text, kind: 'as_is' };
  }
  const missing = writes.filter((write) => !write.times.some((time) => text.includes(time)));
  if (missing.length === 0) return { text, kind: 'as_is' };
  const summary = missing.map((write) => write.summary).join('\n');
  const combined = `${text}\n\n${summary}`;
  return {
    text: combined.length <= maxLength ? combined : summary,
    kind: 'deterministic_summary',
  };
}

/** Texto do contato quando o laço falhou **depois** de uma escrita: o resumo do que ficou gravado. */
export function summaryReply(writes: readonly ScheduleWriteRecord[]): string {
  return writes.map((write) => write.summary).join('\n');
}
