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
  /** Opções da empresa para a IA (spec 028): sem `enabled`, a IA não solicita, cancela nem remarca. */
  readonly ai?: { readonly bookingEnabled: boolean; readonly autoConfirm: boolean };
}

/**
 * Lê os horários livres da empresa para o prompt da IA (spec 027, E3): irmã do `KnowledgeRetriever`.
 * Implementação em `infrastructure/database/`; **sempre** filtra por `companyId` e usa o mesmo
 * `computeSlots` da API. Só leitura: a IA informa, não marca (quem garante é a restrição do banco).
 */
export interface ScheduleAvailabilityReader {
  /**
   * Sem `range`, os próximos `SCHEDULE_PROMPT_WINDOW_DAYS` dias a partir de hoje. Com `range` (datas locais
   * `YYYY-MM-DD`; a ferramenta `listar_horarios` da spec 028), o início (padrão: hoje) nunca é antes de
   * hoje e o fim (padrão: início + 6 dias) é cortado em 7 dias a partir do início.
   */
  read(
    companyId: CompanyId,
    range?: { readonly fromDate?: string; readonly toDate?: string },
  ): Promise<ScheduleAvailability>;
  /**
   * Agendamentos **ativos e futuros do contato** (`company_id` e `contact_ref` no `where`), os mais
   * próximos primeiro, até `limit`. Só serviço, data/hora local e estado: nunca `customer_label`,
   * `contact_ref` nem recurso (spec 028, `<meus_agendamentos>`); o `id` só alimenta o mapa do turno.
   */
  readContactAppointments(
    companyId: CompanyId,
    contactRef: string,
    limit: number,
  ): Promise<readonly ContactAppointmentView[]>;
}

export interface ContactAppointmentView {
  /**
   * Id do agendamento: **só** para o mapa `número -> id` do turno (spec 028). Nunca vai ao prompt, a log, a
   * métrica nem ao modelo.
   */
  readonly id: string;
  /** Nome do serviço (dado da empresa: quem monta o prompt o neutraliza). */
  readonly serviceName: string;
  /** `YYYY-MM-DD` e `HH:mm` no fuso da empresa. */
  readonly localDate: string;
  readonly localStart: string;
  readonly status: 'PENDING' | 'CONFIRMED';
}
