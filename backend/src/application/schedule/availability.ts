import type { AvailabilityWindow, BusyInterval } from '../../domain/index.js';
import {
  addDays,
  daysBetween,
  formatLocalTime,
  isoWeekday,
  localPartsOf,
  zonedToInstant,
} from './zoned-time.js';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export interface SlotResource {
  readonly id: string;
  readonly windows: readonly AvailabilityWindow[];
}

export interface ComputeSlotsInput {
  readonly timezone: string;
  readonly slotStepMinutes: number;
  readonly minNoticeMinutes: number;
  readonly maxAdvanceDays: number;
  readonly service: { readonly durationMinutes: number; readonly bufferMinutes: number };
  /** Recursos já filtrados (ativos) e na ordem desejada para o desempate. */
  readonly resources: readonly SlotResource[];
  /** Itens ativos (PENDING/CONFIRMED) que podem tocar o intervalo. */
  readonly busy: readonly BusyInterval[];
  readonly now: Date;
  /** Datas locais `YYYY-MM-DD`, inclusive nas duas pontas. */
  readonly fromDate: string;
  readonly toDate: string;
}

export interface Slot {
  readonly resourceId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly localDate: string;
  readonly localStart: string;
  readonly localEnd: string;
}

/**
 * Horários livres (spec 027). Função pura: o relógio entra por `now`. Para cada dia local do intervalo e
 * cada janela do recurso, gera candidatos a cada `slotStepMinutes` e mantém os que (1) cabem inteiros
 * na janela, (2) respeitam a antecedência mínima e o teto de dias, (3) não colidem com nenhum
 * `[startsAt, blockedUntil)` ativo, considerando que o novo ocupa `duração + intervalo` e (4) existem no
 * calendário local (descarta a lacuna do horário de verão). É só uma **sugestão**: quem garante é a
 * restrição do banco (`SLOT_TAKEN`).
 */
export function computeSlots(input: ComputeSlotsInput): Slot[] {
  const { service, timezone } = input;
  const earliest = input.now.getTime() + input.minNoticeMinutes * MINUTE_MS;
  const latest = input.now.getTime() + input.maxAdvanceDays * DAY_MS;
  const occupiedMs = (service.durationMinutes + service.bufferMinutes) * MINUTE_MS;
  const durationMs = service.durationMinutes * MINUTE_MS;
  const days = daysBetween(input.fromDate, input.toDate);
  const slots: Slot[] = [];

  for (const resource of input.resources) {
    const busy = input.busy
      .filter((item) => item.resourceId === resource.id)
      .map((item) => [item.startsAt.getTime(), item.blockedUntil.getTime()] as const);
    for (let offset = 0; offset <= days; offset += 1) {
      const date = addDays(input.fromDate, offset);
      const weekday = isoWeekday(date);
      const windows = resource.windows
        .filter((window) => window.weekday === weekday)
        .sort((left, right) => left.startMinute - right.startMinute);
      for (const window of windows) {
        for (
          let start = window.startMinute;
          start + service.durationMinutes <= window.endMinute;
          start += input.slotStepMinutes
        ) {
          const startsAt = zonedToInstant(date, start, timezone);
          if (startsAt === null) continue; // lacuna do horário de verão
          const startMs = startsAt.getTime();
          if (startMs < earliest || startMs > latest) continue;
          const collides = busy.some(
            ([busyStart, busyEnd]) => startMs < busyEnd && startMs + occupiedMs > busyStart,
          );
          if (collides) continue;
          const endsAt = new Date(startMs + durationMs);
          slots.push({
            resourceId: resource.id,
            startsAt,
            endsAt,
            localDate: date,
            localStart: formatLocalTime(startsAt, timezone),
            localEnd: formatLocalTime(endsAt, timezone),
          });
        }
      }
    }
  }
  const order = new Map(input.resources.map((resource, index) => [resource.id, index] as const));
  return slots.sort(
    (left, right) =>
      left.startsAt.getTime() - right.startsAt.getTime() ||
      (order.get(left.resourceId) ?? 0) - (order.get(right.resourceId) ?? 0),
  );
}

/** Data local de hoje no fuso da empresa (para limitar o intervalo e montar o prompt). */
export function todayLocal(now: Date, timezone: string): string {
  return localPartsOf(now, timezone).date;
}
