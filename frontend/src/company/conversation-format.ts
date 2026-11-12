import type { ConversationItem, MessageItem } from './company-api';

/**
 * Formatação e regras puras do painel de conversas (spec 024). Tudo recebe o "agora" e o fuso por
 * parâmetro, para o teste não depender do relógio nem do fuso da máquina.
 */

/** Depois disto sem `sentAt`, a resposta do WhatsApp deixa de ser "Enviando…" e vira "Não enviada". */
export const SEND_GRACE_MS = 2 * 60 * 1000;

const LOCALE = 'pt-BR';

function parts(date: Date, timeZone: string | undefined): { y: number; m: number; d: number } {
  const text = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(date);
  const [y = 0, m = 0, d = 0] = text.split('-').map(Number);
  return { y, m, d };
}

/** Dia civil (`AAAA-MM-DD`) de um instante, no fuso dado. */
export function dayKey(iso: string, timeZone?: string): string {
  const { y, m, d } = parts(new Date(iso), timeZone);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Quantos dias civis separam `iso` de `now` (0 = hoje, 1 = ontem, ...), no fuso dado. */
function daysBefore(iso: string, now: Date, timeZone: string | undefined): number {
  const then = parts(new Date(iso), timeZone);
  const today = parts(now, timeZone);
  return Math.round(
    (Date.UTC(today.y, today.m - 1, today.d) - Date.UTC(then.y, then.m - 1, then.d)) / 86_400_000,
  );
}

/** "Hoje", "Ontem" ou a data (`dd/mm/aaaa`), para o separador de dia do histórico. */
export function dayLabel(iso: string, now: Date, timeZone?: string): string {
  const diff = daysBefore(iso, now, timeZone);
  if (diff === 0) return 'Hoje';
  if (diff === 1) return 'Ontem';
  return new Intl.DateTimeFormat(LOCALE, {
    dateStyle: 'short',
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(new Date(iso));
}

/** Hora (`HH:mm`) de um instante, no fuso dado. */
export function formatTime(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    timeStyle: 'short',
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(new Date(iso));
}

/**
 * Data e hora da última atividade, para a lista: só a hora se foi hoje, "Ontem, HH:mm" se foi ontem e
 * data e hora nos demais casos.
 */
export function formatActivity(iso: string, now: Date, timeZone?: string): string {
  const diff = daysBefore(iso, now, timeZone);
  const time = formatTime(iso, timeZone);
  if (diff === 0) return `Hoje, ${time}`;
  if (diff === 1) return `Ontem, ${time}`;
  return new Intl.DateTimeFormat(LOCALE, {
    dateStyle: 'short',
    timeStyle: 'short',
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(new Date(iso));
}

export type SendIndicator = 'none' | 'sending' | 'not-sent';

/**
 * Indicador de envio da resposta do assistente. Só existe em conversa do WhatsApp (a do simulador
 * nunca vai ao canal, então `sentAt` nulo ali é normal): `sentAt` nulo com no máximo 2 minutos é
 * "Enviando…"; passou disso, "Não enviada". Relógio adiantado (idade negativa) conta como "Enviando…".
 */
export function sendIndicator(
  message: Pick<MessageItem, 'role' | 'sentAt' | 'createdAt'>,
  channel: ConversationItem['channel'],
  now: Date,
): SendIndicator {
  if (channel !== 'whatsapp' || message.role !== 'ASSISTANT' || message.sentAt !== null) {
    return 'none';
  }
  const age = now.getTime() - new Date(message.createdAt).getTime();
  return age > SEND_GRACE_MS ? 'not-sent' : 'sending';
}

/** Páginas buscadas com `order=desc` chegam da mais nova para a mais antiga: ordem do chat (cópia). */
export function chronological<T>(descending: readonly T[]): T[] {
  return [...descending].reverse();
}

export type HistoryEntry =
  | { readonly kind: 'day'; readonly key: string; readonly label: string }
  | { readonly kind: 'message'; readonly message: MessageItem };

/** Intercala o separador de dia (quando o dia civil muda) entre as mensagens em ordem cronológica. */
export function withDaySeparators(
  messages: readonly MessageItem[],
  now: Date,
  timeZone?: string,
): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  let current: string | null = null;
  for (const message of messages) {
    const key = dayKey(message.createdAt, timeZone);
    if (key !== current) {
      current = key;
      entries.push({ kind: 'day', key, label: dayLabel(message.createdAt, now, timeZone) });
    }
    entries.push({ kind: 'message', message });
  }
  return entries;
}

/** Quem escreveu a mensagem (spec 039: `HUMAN` é a equipe, pelo aplicativo no celular). Texto, não só cor. */
export function authorLabel(role: MessageItem['role']): string {
  if (role === 'USER') return 'Contato';
  if (role === 'HUMAN') return 'Equipe (pelo celular)';
  return 'Assistente';
}

/** A mensagem é do lado da empresa (assistente ou equipe)? Fica à direita no histórico. */
export function isCompanySide(role: MessageItem['role']): boolean {
  return role !== 'USER';
}

/** A IA está pausada (spec 039)? `aiPausedUntil` no futuro; vencida ou ausente = ativa. */
export function isAiPaused(aiPausedUntil: string | null | undefined, now: Date): boolean {
  if (aiPausedUntil === null || aiPausedUntil === undefined) return false;
  const until = new Date(aiPausedUntil).getTime();
  return Number.isFinite(until) && until > now.getTime();
}

/**
 * Texto da faixa de pausa (spec 039): "A IA está pausada neste contato até HH:mm de dd/MM porque a
 * equipe respondeu pelo celular", ou `null` se a pausa já passou.
 */
export function pauseBannerText(
  aiPausedUntil: string | null | undefined,
  now: Date,
  timeZone?: string,
): string | null {
  if (!isAiPaused(aiPausedUntil, now) || aiPausedUntil == null) return null;
  const date = new Date(aiPausedUntil);
  const zone = timeZone === undefined ? {} : { timeZone };
  const time = new Intl.DateTimeFormat(LOCALE, { timeStyle: 'short', ...zone }).format(date);
  const day = new Intl.DateTimeFormat(LOCALE, { day: '2-digit', month: '2-digit', ...zone }).format(
    date,
  );
  return `A IA está pausada neste contato até ${time} de ${day} porque a equipe respondeu pelo celular.`;
}
