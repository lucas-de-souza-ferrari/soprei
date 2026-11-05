import type { Appointment, AgendaWindow, AppointmentStatus } from './agenda-api';

/**
 * Regras puras da tela de agenda (spec 027). **Sem fuso:** todo cálculo aqui é de calendário (datas
 * `YYYY-MM-DD` vindas do servidor, em `Date.UTC`); quem converte instantes para a hora da empresa é o
 * servidor (`localDate`, `localStart`, `localEnd`).
 */
export const STATUS_LABELS: Readonly<Record<AppointmentStatus, string>> = {
  PENDING: 'Pendente',
  CONFIRMED: 'Confirmado',
  CANCELLED: 'Cancelado',
  COMPLETED: 'Concluído',
  NO_SHOW: 'Faltou',
};

export const WEEKDAY_LABELS: readonly string[] = [
  'Segunda-feira',
  'Terça-feira',
  'Quarta-feira',
  'Quinta-feira',
  'Sexta-feira',
  'Sábado',
  'Domingo',
];

export const SLOT_STEPS: readonly number[] = [5, 10, 15, 20, 30, 60];
export const CUSTOMER_LABEL_MAX_LENGTH = 60;
export const NAME_MAX_LENGTH = 80;

const DAY_MS = 86_400_000;

function parts(date: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) throw new RangeError('data inválida');
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

const pad = (value: number): string => String(value).padStart(2, '0');

export function addDays(date: string, days: number): string {
  const [year, month, day] = parts(date);
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return `${String(moved.getUTCFullYear()).padStart(4, '0')}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}`;
}

/** Dia da semana ISO (1 = segunda a 7 = domingo). */
export function isoWeekday(date: string): number {
  const [year, month, day] = parts(date);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

/** Segunda-feira da semana que contém `date`. */
export function weekStart(date: string): string {
  return addDays(date, 1 - isoWeekday(date));
}

/** As sete datas da semana que começa em `start` (uma segunda-feira). */
export function weekDates(start: string): string[] {
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

export function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = parts(from);
  const [ty, tm, td] = parts(to);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / DAY_MS);
}

const headingFormat = new Intl.DateTimeFormat('pt-BR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
});
const shortFormat = new Intl.DateTimeFormat('pt-BR', {
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
});
const dayOnlyFormat = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', timeZone: 'UTC' });

function asCalendar(date: string): Date {
  const [year, month, day] = parts(date);
  return new Date(Date.UTC(year, month - 1, day));
}

/** "terça-feira, 10 de novembro" (formata a data de calendário em UTC: não depende do fuso do navegador). */
export function dayHeading(date: string): string {
  return headingFormat.format(asCalendar(date));
}

/** "10 a 16 de novembro" (ou "28 de outubro a 3 de novembro" quando a semana cruza o mês). */
export function weekLabel(start: string): string {
  const end = addDays(start, 6);
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  return sameMonth
    ? `${dayOnlyFormat.format(asCalendar(start))} a ${shortFormat.format(asCalendar(end))}`
    : `${shortFormat.format(asCalendar(start))} a ${shortFormat.format(asCalendar(end))}`;
}

/** Texto do aviso `aria-live`: "3 agendamentos de 10 a 16 de novembro". */
export function weekAnnouncement(start: string, count: number): string {
  const noun = count === 1 ? 'agendamento' : 'agendamentos';
  return `${String(count)} ${noun} de ${weekLabel(start)}`;
}

export interface DayGroup {
  readonly date: string;
  readonly items: readonly Appointment[];
}

/** Agrupa por `localDate` (do servidor), um grupo por dia da semana, na ordem em que os itens vieram. */
export function groupByDay(items: readonly Appointment[], dates: readonly string[]): DayGroup[] {
  return dates.map((date) => ({ date, items: items.filter((item) => item.localDate === date) }));
}

export type ItemAction = 'confirm' | 'reschedule' | 'cancel' | 'complete' | 'no_show' | 'unblock';

/**
 * Ações oferecidas a um item (só conveniência de tela: o servidor valida a transição). `started` diz se
 * o início já passou (concluir e "faltou" só valem depois dele).
 */
export function allowedActions(item: Appointment, started: boolean): ItemAction[] {
  if (item.kind === 'BLOCK') return item.status === 'CONFIRMED' ? ['unblock'] : [];
  if (item.status === 'PENDING') return ['confirm', 'reschedule', 'cancel'];
  if (item.status === 'CONFIRMED') {
    return started ? ['reschedule', 'cancel', 'complete', 'no_show'] : ['reschedule', 'cancel'];
  }
  return [];
}

export const ACTION_LABELS: Readonly<Record<ItemAction, string>> = {
  confirm: 'Confirmar',
  reschedule: 'Remarcar',
  cancel: 'Cancelar agendamento',
  complete: 'Marcar como concluído',
  no_show: 'Marcar que faltou',
  unblock: 'Remover bloqueio',
};

/** O início (ISO) já passou? Comparação de instantes: não envolve fuso. */
export function hasStarted(startsAtIso: string, nowMs: number): boolean {
  return Date.parse(startsAtIso) <= nowMs;
}

/** Resumo de uma linha de item: `14:30 às 15:00 · Corte de cabelo · João · Confirmado`. */
export function itemSummary(item: Appointment): string {
  if (item.kind === 'BLOCK') {
    return `${item.localStart} às ${item.localEnd} · Bloqueado`;
  }
  const who = item.customerLabel ?? item.contactLabel;
  const pieces = [
    `${item.localStart} às ${item.localEnd}`,
    item.serviceName ?? 'Serviço',
    ...(who === null ? [] : [who]),
    STATUS_LABELS[item.status],
  ];
  return pieces.join(' · ');
}

const CONTROL = /\p{Cc}/u;

/** Problema do nome de quem é atendido (só nome; opcional), ou `null`. */
export function customerLabelProblem(value: string): string | null {
  const text = value.trim();
  if (text === '') return null;
  if (text.length > CUSTOMER_LABEL_MAX_LENGTH) return 'O nome pode ter até 60 caracteres.';
  if (CONTROL.test(text)) return 'Use só o nome, em uma linha.';
  return null;
}

export function serviceFormProblem(values: {
  name: string;
  duration: string;
  buffer: string;
}): string | null {
  const name = values.name.trim();
  if (name === '' || name.length > NAME_MAX_LENGTH)
    return 'Informe o nome do serviço (até 80 caracteres).';
  const duration = Number(values.duration);
  if (!Number.isInteger(duration) || duration < 5 || duration > 480 || duration % 5 !== 0) {
    return 'A duração deve ser de 5 a 480 minutos, em múltiplos de 5.';
  }
  const buffer = values.buffer.trim() === '' ? 0 : Number(values.buffer);
  if (!Number.isInteger(buffer) || buffer < 0 || buffer > 120) {
    return 'O intervalo depois do serviço deve ser de 0 a 120 minutos.';
  }
  return null;
}

/** Minutos desde 00:00 de um `HH:mm`, ou `null` se inválido. */
export function minutesOf(time: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59 || hour > 24 || (hour === 24 && minute !== 0)) return null;
  return hour * 60 + minute;
}

/** Problema do conjunto de janelas (fim depois do início, sem sobreposição, no máximo 6 por dia). */
export function windowsProblem(windows: readonly AgendaWindow[]): string | null {
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    const day = windows
      .filter((window) => window.weekday === weekday)
      .map((window) => ({ start: minutesOf(window.start), end: minutesOf(window.end) }));
    if (day.length > 6) return 'No máximo 6 horários por dia.';
    for (const window of day) {
      if (window.start === null || window.end === null || window.start >= window.end) {
        return 'Em cada horário, o fim deve ser depois do início.';
      }
    }
    const sorted = day
      .filter(
        (window): window is { start: number; end: number } =>
          window.start !== null && window.end !== null,
      )
      .sort((left, right) => left.start - right.start);
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      if (previous !== undefined && current !== undefined && current.start < previous.end) {
        return 'Os horários do mesmo dia não podem se sobrepor.';
      }
    }
  }
  return null;
}

/** `YYYY-MM-DDTHH:mm` a partir de uma data e de uma hora locais (a empresa interpreta no fuso dela). */
export function localStartOf(date: string, time: string): string {
  return `${date}T${time}`;
}
