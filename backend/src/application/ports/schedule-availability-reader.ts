import type { CompanyId } from '../../domain/index.js';

/** Um horário livre de um serviço, já no relógio local da empresa (nunca calculado pelo prompt). */
export interface AvailableSlot {
  /** `YYYY-MM-DD` no fuso da empresa. */
  readonly localDate: string;
  /** `HH:mm` no fuso da empresa. */
  readonly localStart: string;
}

export interface ServiceAvailability {
  readonly name: string;
  readonly durationMinutes: number;
  /** Do mais próximo ao mais distante, sem repetição (vários recursos no mesmo horário contam uma vez). */
  readonly slots: readonly AvailableSlot[];
}

export interface ScheduleAvailability {
  readonly timezone: string;
  /** Hora da leitura: o prompt a mostra e avisa que um horário pode ser tomado a qualquer momento. */
  readonly generatedAt: Date;
  /** Data de hoje no fuso da empresa (`YYYY-MM-DD`). */
  readonly today: string;
  /** Serviços ativos, os mais próximos no tempo primeiro. Só leitura: nada é gravado. */
  readonly services: readonly ServiceAvailability[];
  /** A empresa tem agenda configurada (ao menos um serviço ativo). Sem ela o prompt não muda. */
  readonly hasSchedule: boolean;
}

/**
 * Lê os horários livres da empresa para o prompt da IA (spec 027, E3): irmã do `KnowledgeRetriever`.
 * Implementação em `infrastructure/database/`; **sempre** filtra por `companyId` e usa o mesmo
 * `computeSlots` da API. Só leitura: a IA informa, não marca (quem garante é a restrição do banco).
 */
export interface ScheduleAvailabilityReader {
  read(companyId: CompanyId): Promise<ScheduleAvailability>;
}
