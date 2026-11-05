import type { CompanyId } from './value-objects/company-id.js';

/**
 * Agenda da empresa (spec 027). Tudo por empresa; instantes em UTC; a hora local de cada empresa é o
 * seu fuso (IANA). Limites são constantes nomeadas (sem variável de ambiente). Nome de serviço,
 * `customerLabel`, `contactRef` e horários de agendamento nunca vão a log nem a label de métrica.
 */
export const SCHEDULE_DEFAULT_TIMEZONE = 'America/Sao_Paulo';
export const SCHEDULE_SLOT_STEPS = [5, 10, 15, 20, 30, 60] as const;
export const SCHEDULE_DEFAULT_SLOT_STEP_MINUTES = 30;
export const SCHEDULE_DEFAULT_MIN_NOTICE_MINUTES = 120;
export const SCHEDULE_MAX_MIN_NOTICE_MINUTES = 10_080;
export const SCHEDULE_DEFAULT_MAX_ADVANCE_DAYS = 60;
export const SCHEDULE_MAX_ADVANCE_DAYS = 365;
export const SCHEDULE_MAIN_RESOURCE_NAME = 'Agenda principal';

export const SCHEDULE_MAX_RESOURCES = 20;
export const SCHEDULE_MAX_SERVICES = 50;
export const SCHEDULE_MAX_WINDOWS_PER_DAY = 6;
export const SCHEDULE_NAME_MAX_LENGTH = 80;
export const SCHEDULE_CUSTOMER_LABEL_MAX_LENGTH = 60;
export const SCHEDULE_SERVICE_DURATION_MIN = 5;
export const SCHEDULE_SERVICE_DURATION_MAX = 480;
export const SCHEDULE_SERVICE_BUFFER_MAX = 120;

/** Intervalo máximo (em dias) das consultas de horários livres e de agendamentos. */
export const SCHEDULE_AVAILABILITY_MAX_DAYS = 14;
export const SCHEDULE_APPOINTMENTS_MAX_DAYS = 42;
/** Itens por consulta de agendamentos; acima disso é erro (`RANGE_TOO_LARGE`), nunca truncamento. */
export const SCHEDULE_APPOINTMENTS_MAX_ITEMS = 500;
/** Agendamentos ativos futuros por empresa (de melhor esforço sob concorrência). */
export const SCHEDULE_MAX_ACTIVE_FUTURE = 5_000;
export const SCHEDULE_BLOCK_MAX_RESOURCES = 20;

/** Prompt da IA (somente leitura): tetos duros por turno. */
export const SCHEDULE_PROMPT_MAX_SERVICES = 5;
export const SCHEDULE_PROMPT_MAX_SLOTS_PER_SERVICE = 6;
export const SCHEDULE_PROMPT_WINDOW_DAYS = 7;
export const SCHEDULE_PROMPT_BLOCK_MAX_CHARS = 1_200;
export const SCHEDULE_RETRIEVAL_TIMEOUT_MS = 1_500;

/**
 * Palavras de intenção (sem acento, minúsculas): só com uma delas no texto do contato a agenda é
 * consultada. Conservadora de propósito (custo de tokens): ficar de fora só faz a IA responder sem
 * horários.
 */
export const SCHEDULE_INTENT_WORDS: readonly string[] = [
  'agendar',
  'agendamento',
  'agenda',
  'marcar',
  'marcacao',
  'horario',
  'horarios',
  'consulta',
  'reservar',
  'reserva',
  'remarcar',
  'cancelar',
  'vaga',
  'vagas',
  'disponivel',
  'disponiveis',
  'disponibilidade',
  'atendem',
  'atende',
  'amanha',
  'hoje',
];

export const APPOINTMENT_KINDS = ['BOOKING', 'BLOCK'] as const;
export type AppointmentKind = (typeof APPOINTMENT_KINDS)[number];

export const APPOINTMENT_STATUSES = [
  'PENDING',
  'CONFIRMED',
  'CANCELLED',
  'COMPLETED',
  'NO_SHOW',
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/** Estados que seguram o horário (os mesmos do `WHERE` da restrição de exclusão no banco). */
export const ACTIVE_APPOINTMENT_STATUSES = ['PENDING', 'CONFIRMED'] as const;

export const APPOINTMENT_SOURCES = ['PANEL', 'CHANNEL'] as const;
export type AppointmentSource = (typeof APPOINTMENT_SOURCES)[number];
export type AppointmentCancelledBy = 'PANEL' | 'CONTACT';

export function isActiveStatus(status: AppointmentStatus): boolean {
  return status === 'PENDING' || status === 'CONFIRMED';
}

/**
 * Transições permitidas (os estados terminais não mudam; `COMPLETED` e `NO_SHOW` só depois do início,
 * regra checada pelo serviço). Cancelar de novo um cancelado é idempotente e não passa por aqui.
 */
export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  if (from === 'PENDING') return to === 'CONFIRMED' || to === 'CANCELLED';
  if (from === 'CONFIRMED') return to === 'CANCELLED' || to === 'COMPLETED' || to === 'NO_SHOW';
  return false;
}

export interface ScheduleSettings {
  readonly companyId: CompanyId;
  readonly timezone: string;
  readonly slotStepMinutes: number;
  readonly minNoticeMinutes: number;
  readonly maxAdvanceDays: number;
}

export type ScheduleSettingsUpdate = Partial<
  Pick<ScheduleSettings, 'timezone' | 'slotStepMinutes' | 'minNoticeMinutes' | 'maxAdvanceDays'>
>;

export interface ScheduleResource {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly name: string;
  readonly active: boolean;
  readonly position: number;
}

export interface ScheduleServiceItem {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly name: string;
  readonly durationMinutes: number;
  readonly bufferMinutes: number;
  readonly active: boolean;
  readonly isSample: boolean;
}

export interface NewScheduleService {
  readonly name: string;
  readonly durationMinutes: number;
  readonly bufferMinutes: number;
  readonly isSample?: boolean;
}

export type ScheduleServiceUpdate = Partial<
  Pick<ScheduleServiceItem, 'name' | 'durationMinutes' | 'bufferMinutes' | 'active'>
>;

/** Janela semanal no relógio local da empresa (`weekday` 1 = segunda a 7 = domingo; minutos desde 00:00). */
export interface AvailabilityWindow {
  readonly weekday: number;
  readonly startMinute: number;
  readonly endMinute: number;
}

export interface AvailabilityRuleItem extends AvailabilityWindow {
  readonly resourceId: string;
}

export interface Appointment {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly resourceId: string;
  readonly serviceId: string | null;
  readonly kind: AppointmentKind;
  readonly status: AppointmentStatus;
  readonly startsAt: Date;
  readonly endsAt: Date;
  /** `endsAt` mais o intervalo do serviço na hora da reserva: o que bloqueia o recurso. */
  readonly blockedUntil: Date;
  readonly customerLabel: string | null;
  /** Só o canal preenche (Anexo B); **nunca** sai em resposta de API. */
  readonly contactRef: string | null;
  readonly source: AppointmentSource;
  readonly createdByMembershipId: string | null;
  readonly cancelledAt: Date | null;
  readonly cancelledBy: AppointmentCancelledBy | null;
  readonly createdAt: Date;
}

export interface NewAppointment {
  readonly resourceId: string;
  readonly serviceId: string | null;
  readonly kind: AppointmentKind;
  readonly status: 'PENDING' | 'CONFIRMED';
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly blockedUntil: Date;
  readonly customerLabel: string | null;
  readonly contactRef: string | null;
  readonly source: AppointmentSource;
  readonly createdByMembershipId: string | null;
}

export interface AppointmentFilter {
  /** Instante inicial (inclusive) e final (exclusivo) sobre `startsAt`. */
  readonly from: Date;
  readonly to: Date;
  readonly resourceId?: string | undefined;
  readonly serviceId?: string | undefined;
  readonly status?: AppointmentStatus | undefined;
  /** Mais um que o teto, para detectar "grande demais" sem truncar em silêncio. */
  readonly limit: number;
}

/** Item ativo que ocupa o recurso (entrada do cálculo de horários livres). */
export interface BusyInterval {
  readonly resourceId: string;
  readonly startsAt: Date;
  readonly blockedUntil: Date;
}

export interface ScheduleSettingsRepository {
  /** Devolve as configurações; se a empresa ainda não tem, cria os padrões e a "Agenda principal". */
  ensure(companyId: CompanyId): Promise<ScheduleSettings>;
  update(companyId: CompanyId, patch: ScheduleSettingsUpdate): Promise<ScheduleSettings>;
}

export interface ScheduleResourceRepository {
  /** Por posição e `id`. */
  list(companyId: CompanyId): Promise<ScheduleResource[]>;
  findById(companyId: CompanyId, resourceId: string): Promise<ScheduleResource>;
  create(companyId: CompanyId, data: { name: string; position: number }): Promise<ScheduleResource>;
  update(
    companyId: CompanyId,
    resourceId: string,
    patch: { name?: string; active?: boolean; position?: number },
  ): Promise<ScheduleResource>;
}

export interface ScheduleServiceRepository {
  /** Por nome e `id`. */
  list(companyId: CompanyId): Promise<ScheduleServiceItem[]>;
  findById(companyId: CompanyId, serviceId: string): Promise<ScheduleServiceItem>;
  create(companyId: CompanyId, data: NewScheduleService): Promise<ScheduleServiceItem>;
  update(
    companyId: CompanyId,
    serviceId: string,
    patch: ScheduleServiceUpdate,
  ): Promise<ScheduleServiceItem>;
  listSamples(companyId: CompanyId): Promise<ScheduleServiceItem[]>;
}

export interface AvailabilityRuleRepository {
  /** Janelas de vários recursos da empresa, ordenadas (recurso, dia, início). */
  listForResources(
    companyId: CompanyId,
    resourceIds: readonly string[],
  ): Promise<AvailabilityRuleItem[]>;
  /** Substitui o conjunto de um recurso numa transação com a linha do recurso travada. */
  replaceForResource(
    companyId: CompanyId,
    resourceId: string,
    windows: readonly AvailabilityWindow[],
  ): Promise<void>;
}

export interface AppointmentRepository {
  /** Ordenado por `startsAt` e `id`; até `filter.limit` itens. */
  list(companyId: CompanyId, filter: AppointmentFilter): Promise<Appointment[]>;
  findById(companyId: CompanyId, appointmentId: string): Promise<Appointment>;
  /** Itens ativos (PENDING/CONFIRMED) que tocam `[from, to)`, dos recursos pedidos. */
  listBusy(
    companyId: CompanyId,
    resourceIds: readonly string[],
    from: Date,
    to: Date,
  ): Promise<BusyInterval[]>;
  /** Ativos com início depois de `after` (teto por empresa e "recurso com agendamento futuro"). */
  countActiveFuture(
    companyId: CompanyId,
    after: Date,
    options?: { readonly resourceId?: string; readonly kind?: AppointmentKind },
  ): Promise<number>;
  /** Um único `INSERT`. Sobreposição = `ConflictError` `SLOT_TAKEN` (restrição do banco). */
  create(companyId: CompanyId, data: NewAppointment): Promise<Appointment>;
  /** Vários `INSERT` numa transação: tudo ou nada (`SLOT_TAKEN` desfaz todos). */
  createMany(companyId: CompanyId, data: readonly NewAppointment[]): Promise<Appointment[]>;
  /**
   * Muda o estado só se o atual ainda é `from` (corrida entre duas mudanças). Devolve `null` se o
   * estado já não era `from`. `cancelledBy` vale só em `CANCELLED`.
   */
  transition(
    companyId: CompanyId,
    appointmentId: string,
    change: {
      readonly from: AppointmentStatus;
      readonly to: AppointmentStatus;
      readonly now: Date;
      readonly cancelledBy?: AppointmentCancelledBy;
    },
  ): Promise<Appointment | null>;
  /**
   * Remarca a mesma linha, numa instrução, só se ainda ativa. `null` se não está mais ativa.
   * Sobreposição = `SLOT_TAKEN` e **nada muda**.
   */
  reschedule(
    companyId: CompanyId,
    appointmentId: string,
    time: { readonly startsAt: Date; readonly endsAt: Date; readonly blockedUntil: Date },
  ): Promise<Appointment | null>;
  updateCustomerLabel(
    companyId: CompanyId,
    appointmentId: string,
    customerLabel: string | null,
  ): Promise<Appointment>;
}
