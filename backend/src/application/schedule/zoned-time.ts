/**
 * Conversão entre relógio da parede de um fuso (IANA) e instantes UTC (spec 027). **Único** módulo de
 * fuso do sistema; sem dependência (só `Intl.DateTimeFormat` com `timeZone`). Funções puras: o relógio
 * entra por parâmetro.
 *
 * - Horário local **inexistente** (lacuna da entrada no horário de verão) não tem instante (`null`).
 * - Horário local **ambíguo** (repetido na saída do horário de verão) usa a **primeira** ocorrência.
 */
export interface LocalParts {
  /** `YYYY-MM-DD` no fuso. */
  readonly date: string;
  /** Minutos desde 00:00 local. */
  readonly minute: number;
  /** 1 = segunda a 7 = domingo. */
  readonly weekday: number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** O fuso é um identificador IANA que o `Intl` conhece? (nunca lança) */
export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone.length === 0 || timeZone.length > 64) return false;
  // Só nomes IANA de região (`Area/Cidade`) ou `UTC`: o `Intl` também aceita deslocamentos (`+03:00`) e
  // `Etc/GMT+3`, que não são fusos de empresa (e `Etc/GMT+3` tem o sinal invertido). Nem o
  // `Intl.supportedValuesOf` serve de lista (não traz `UTC` nem apelidos antigos).
  if (timeZone !== 'UTC' && !/^(?!Etc\/)[A-Za-z]+(?:\/[A-Za-z0-9_-]+)+$/.test(timeZone)) return false;
  try {
    formatterFor(timeZone).format(0);
    return true;
  } catch {
    formatters.delete(timeZone);
    return false;
  }
}

interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function wallClockOf(instantMs: number, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(instantMs);
  const pick = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour: pick('hour'),
    minute: pick('minute'),
    second: pick('second'),
  };
}

const pad = (value: number, size = 2): string => String(value).padStart(size, '0');

function dateString(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/** Deslocamento do fuso (em ms, local menos UTC) no instante dado. */
function offsetMs(instantMs: number, timeZone: string): number {
  const wall = wallClockOf(instantMs, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** Dia da semana ISO (1 = segunda a 7 = domingo) de uma data `YYYY-MM-DD`. */
export function isoWeekday(date: string): number {
  const [year, month, day] = parseDate(date);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function parseDate(date: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) throw new RangeError('data local inválida');
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Soma `days` (pode ser negativo) a uma data `YYYY-MM-DD` (aritmética de calendário, sem fuso). */
export function addDays(date: string, days: number): string {
  const [year, month, day] = parseDate(date);
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return dateString(moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate());
}

/** Dias entre duas datas locais (`to` menos `from`). */
export function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = parseDate(from);
  const [ty, tm, td] = parseDate(to);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / DAY_MS);
}

/** A data `YYYY-MM-DD` existe no calendário? (ano bissexto incluso) */
export function isValidLocalDate(date: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
  );
}

/** Data, minuto do dia e dia da semana locais de um instante. */
export function localPartsOf(instant: Date, timeZone: string): LocalParts {
  const wall = wallClockOf(instant.getTime(), timeZone);
  const date = dateString(wall.year, wall.month, wall.day);
  return { date, minute: wall.hour * 60 + wall.minute, weekday: isoWeekday(date) };
}

/** `HH:mm` de um minuto do dia (0 a 1440; 1440 vira `24:00`). */
export function formatMinute(minute: number): string {
  return `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
}

/** `HH:mm` local de um instante. */
export function formatLocalTime(instant: Date, timeZone: string): string {
  return formatMinute(localPartsOf(instant, timeZone).minute);
}

/**
 * Instante UTC de `date` (`YYYY-MM-DD`) às `minute` (desde 00:00) no relógio local de `timeZone`.
 * `null` quando esse horário local não existe (lacuna do horário de verão); na repetição, a primeira.
 */
export function zonedToInstant(date: string, minute: number, timeZone: string): Date | null {
  const [year, month, day] = parseDate(date);
  const guess = Date.UTC(year, month - 1, day) + minute * MINUTE_MS;
  const candidates = new Set<number>();
  for (const probe of [guess - DAY_MS, guess, guess + DAY_MS]) {
    const instant = guess - offsetMs(probe, timeZone);
    const wall = wallClockOf(instant, timeZone);
    if (
      dateString(wall.year, wall.month, wall.day) === date &&
      wall.hour * 60 + wall.minute === minute
    ) {
      candidates.add(instant);
    }
  }
  if (candidates.size === 0) return null;
  return new Date(Math.min(...candidates));
}

/** Interpreta `YYYY-MM-DDTHH:mm` no relógio do fuso. `null` se o horário não existe ou é inválido. */
export function parseLocalDateTime(value: string, timeZone: string): Date | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (match === null) return null;
  const date = match[1] ?? '';
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  if (!isValidLocalDate(date) || hour > 23 || minute > 59) return null;
  return zonedToInstant(date, hour * 60 + minute, timeZone);
}
