import type { Appointment } from './agenda-api';
import { addDays, dayHeading, isoWeekday, itemSummary, minutesOf, weekStart } from './agenda-rules';

/**
 * Regras puras do calendário da agenda (spec 029, E4). **O navegador não converte fuso:** tudo aqui é
 * aritmética de datas `YYYY-MM-DD` (em `Date.UTC`) e de minutos do relógio **da empresa**, lidos dos campos que
 * o servidor devolve (`localDate`, `localStart`, `localEnd`). Nenhuma `Date` local decide em que dia ou em que
 * hora um item cai.
 */

export type AgendaView = 'list' | 'week' | 'month';

/** A API aceita até 42 dias por consulta: o mês é uma grade de 6 semanas, exatamente esse máximo. */
export const MONTH_GRID_DAYS = 42;
/** Intervalo vertical padrão da semana (minutos desde 00:00): 07:00 às 20:00. */
export const DEFAULT_RANGE_START = 7 * 60;
export const DEFAULT_RANGE_END = 20 * 60;
export const MINUTES_PER_DAY = 24 * 60;
/** O desenho do bloco é arredondado a passos de 15 minutos (o texto mostra o horário real). */
export const DRAW_STEP = 15;
export const MONTH_ITEMS_SHOWN = 3;

export const MONTH_NAMES: readonly string[] = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];

const pad = (value: number): string => String(value).padStart(2, '0');

function ymd(date: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) throw new RangeError('data inválida');
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** Primeiro dia do mês de `date`. */
export function monthStart(date: string): string {
  const { year, month } = ymd(date);
  return `${String(year).padStart(4, '0')}-${pad(month)}-01`;
}

/** Primeiro dia do mês, `delta` meses depois (ou antes) de `date`. */
export function addMonths(date: string, delta: number): string {
  const { year, month } = ymd(date);
  const index = year * 12 + (month - 1) + delta;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${pad((index % 12) + 1)}-01`;
}

/** Os 42 dias da grade do mês, começando na segunda-feira da semana do dia 1. */
export function monthGrid(date: string): string[] {
  const first = weekStart(monthStart(date));
  return Array.from({ length: MONTH_GRID_DAYS }, (_, index) => addDays(first, index));
}

/** `from` e `to` (inclusive) da consulta do mês: sempre 42 dias. */
export function monthRange(date: string): { from: string; to: string } {
  const grid = monthGrid(date);
  return { from: grid[0] ?? date, to: grid[MONTH_GRID_DAYS - 1] ?? date };
}

/** "novembro de 2026". */
export function monthLabel(date: string): string {
  const { year, month } = ymd(date);
  return `${MONTH_NAMES[month - 1] ?? ''} de ${String(year)}`;
}

/** O dia pertence ao mês de `anchor`? */
export function sameMonth(date: string, anchor: string): boolean {
  return date.slice(0, 7) === anchor.slice(0, 7);
}

/** Número do dia no mês (sem zero à esquerda). */
export function dayOfMonth(date: string): number {
  return ymd(date).day;
}

/** Nome do mês de um dia (para o leitor de tela das células de outro mês). */
export function monthNameOf(date: string): string {
  return MONTH_NAMES[ymd(date).month - 1] ?? '';
}

export interface DayBlock {
  readonly item: Appointment;
  readonly date: string;
  /** Minutos desde 00:00 do dia, já limitados ao dia. */
  readonly startMin: number;
  readonly endMin: number;
  /** O item começou no dia anterior / continua no seguinte (atravessa a meia-noite). */
  readonly continuesFromPrevious: boolean;
  readonly continuesToNext: boolean;
  /** Coluna dentro do grupo de itens que se sobrepõem, e quantas colunas o grupo tem. */
  column: number;
  columns: number;
}

/** Arredonda ao passo de desenho (15 min). */
export function snapMinutes(minutes: number): number {
  return Math.round(minutes / DRAW_STEP) * DRAW_STEP;
}

function blocksFor(item: Appointment, dates: ReadonlySet<string>): DayBlock[] {
  const start = minutesOf(item.localStart);
  const end = minutesOf(item.localEnd);
  if (start === null || end === null) return [];
  const crosses = end <= start;
  const result: DayBlock[] = [];
  if (dates.has(item.localDate)) {
    result.push({
      item,
      date: item.localDate,
      startMin: start,
      endMin: crosses ? MINUTES_PER_DAY : end,
      continuesFromPrevious: false,
      continuesToNext: crosses,
      column: 0,
      columns: 1,
    });
  }
  if (crosses) {
    const next = addDays(item.localDate, 1);
    if (dates.has(next)) {
      result.push({
        item,
        date: next,
        startMin: 0,
        endMin: end,
        continuesFromPrevious: true,
        continuesToNext: false,
        column: 0,
        columns: 1,
      });
    }
  }
  return result;
}

/** Atribui colunas aos blocos de um dia: itens que se sobrepõem ficam lado a lado. */
function assignColumns(blocks: DayBlock[]): void {
  const sorted = [...blocks].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  let cluster: DayBlock[] = [];
  let clusterEnd = -1;
  const flush = (): void => {
    const width = cluster.reduce((max, block) => Math.max(max, block.column + 1), 1);
    for (const block of cluster) block.columns = width;
    cluster = [];
  };
  for (const block of sorted) {
    if (cluster.length > 0 && block.startMin >= clusterEnd) {
      flush();
      clusterEnd = -1;
    }
    const taken = new Set(
      cluster.filter((other) => other.endMin > block.startMin).map((other) => other.column),
    );
    let column = 0;
    while (taken.has(column)) column += 1;
    block.column = column;
    cluster.push(block);
    clusterEnd = Math.max(clusterEnd, block.endMin);
  }
  flush();
}

/** Blocos da semana por dia (na ordem das datas), com colunas atribuídas. Agrupa por `localDate`. */
export function weekBlocks(
  items: readonly Appointment[],
  dates: readonly string[],
): Map<string, DayBlock[]> {
  const set = new Set(dates);
  const byDay = new Map<string, DayBlock[]>(dates.map((date) => [date, []]));
  for (const item of items) {
    for (const block of blocksFor(item, set)) byDay.get(block.date)?.push(block);
  }
  for (const blocks of byDay.values()) assignColumns(blocks);
  return byDay;
}

/**
 * Intervalo vertical visível (minutos): 07:00 às 20:00, **ampliado** (em horas cheias) para cobrir o item mais
 * cedo e o mais tarde da semana. Nunca esconde item.
 */
export function visibleRange(blocks: Iterable<DayBlock>): { start: number; end: number } {
  let start = DEFAULT_RANGE_START;
  let end = DEFAULT_RANGE_END;
  for (const block of blocks) {
    start = Math.min(start, Math.floor(block.startMin / 60) * 60);
    end = Math.max(end, Math.ceil(block.endMin / 60) * 60);
  }
  return { start: Math.max(0, start), end: Math.min(MINUTES_PER_DAY, end) };
}

/** Posição vertical de um bloco, em porcentagem do intervalo visível (desenho em passos de 15 min). */
export function blockPosition(
  block: Pick<DayBlock, 'startMin' | 'endMin'>,
  range: { start: number; end: number },
): { top: number; height: number } {
  const span = range.end - range.start;
  const top = Math.max(0, snapMinutes(block.startMin) - range.start);
  const bottom = Math.min(
    span,
    Math.max(snapMinutes(block.endMin), snapMinutes(block.startMin) + DRAW_STEP) - range.start,
  );
  return { top: (top / span) * 100, height: ((bottom - top) / span) * 100 };
}

/** "09:00" de minutos desde 00:00 (24:00 vira "24:00"). */
export function timeLabel(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** Horas cheias do eixo (dentro do intervalo visível). */
export function axisHours(range: { start: number; end: number }): number[] {
  const hours: number[] = [];
  for (let minute = range.start; minute < range.end; minute += 60) hours.push(minute);
  return hours;
}

/** `YYYY-MM-DDTHH:mm` (hora local da empresa; o servidor interpreta no fuso dela) a partir de um clique na coluna. */
export function startAtOffset(
  date: string,
  range: { start: number; end: number },
  fraction: number,
): string {
  const clamped = Math.min(Math.max(fraction, 0), 0.999);
  const minutes =
    Math.floor((range.start + clamped * (range.end - range.start)) / DRAW_STEP) * DRAW_STEP;
  return `${date}T${timeLabel(minutes)}`;
}

/** Nome acessível completo: "terça-feira, 12 de novembro, 09:00 às 09:30, Corte de cabelo, Maria, Confirmado". */
export function itemAccessibleName(item: Appointment): string {
  return [dayHeading(item.localDate), ...itemSummary(item).split(' · ')].join(', ');
}

/** Resumo de uma linha no mês: "09:00 Corte de cabelo" (bloqueio: "09:00 Bloqueado"). */
export function monthItemText(item: Appointment): string {
  return item.kind === 'BLOCK'
    ? `${item.localStart} Bloqueado`
    : `${item.localStart} ${item.serviceName ?? 'Serviço'}`;
}

export interface MonthCell {
  readonly date: string;
  readonly inMonth: boolean;
  readonly shown: readonly Appointment[];
  readonly extra: number;
  readonly total: number;
}

/** Células do mês: até 3 itens resumidos e o "+N" do resto. Agrupa por `localDate`. */
export function monthCells(items: readonly Appointment[], anchor: string): MonthCell[] {
  return monthGrid(anchor).map((date) => {
    const day = items.filter((item) => item.localDate === date);
    return {
      date,
      inMonth: sameMonth(date, anchor),
      shown: day.slice(0, MONTH_ITEMS_SHOWN),
      extra: Math.max(0, day.length - MONTH_ITEMS_SHOWN),
      total: day.length,
    };
  });
}

/** Dia da semana ISO (1 a 7) de uma célula: usado só para o cabeçalho da coluna. */
export function columnOf(date: string): number {
  return isoWeekday(date);
}

/** Aviso `aria-live` do período: "3 agendamentos em novembro de 2026". */
export function monthAnnouncement(anchor: string, count: number): string {
  const noun = count === 1 ? 'agendamento' : 'agendamentos';
  return `${String(count)} ${noun} em ${monthLabel(anchor)}`;
}

export const RANGE_TOO_LARGE_MONTH_MESSAGE =
  'Há itens demais neste mês para mostrar. Use a visão Semana ou filtre por serviço.';
