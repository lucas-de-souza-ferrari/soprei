import type {
  Appointment,
  AvailabilityWindow,
  BusyInterval,
  CompanyId,
  NewAppointment,
  ScheduleServiceItem,
} from '../../domain/index.js';

/**
 * Tudo o que a IA precisa saber da agenda de uma empresa para marcar, cancelar e remarcar (spec 028).
 * Lido **dentro** da transação da escrita, depois do bloqueio da empresa.
 */
export interface ContactScheduleConfig {
  readonly aiBookingEnabled: boolean;
  readonly aiAutoConfirm: boolean;
  readonly timezone: string;
  readonly slotStepMinutes: number;
  readonly minNoticeMinutes: number;
  readonly maxAdvanceDays: number;
  /** Só recursos **ativos**, por posição e `id` (a ordem do desempate). */
  readonly resources: readonly {
    readonly id: string;
    readonly windows: readonly AvailabilityWindow[];
  }[];
  /** Todos os serviços (ativos e inativos): o nome de um serviço desativado ainda aparece no resumo. */
  readonly services: readonly ScheduleServiceItem[];
}

/**
 * Operações de banco de uma escrita da IA. Toda consulta e toda escrita filtra por `companyId` **e**, quando
 * é de contato, por `contactRef`. Implementação em `infrastructure/database/`.
 */
export interface ContactScheduleTransaction {
  /** Trava a linha da empresa (serializa as escritas da IA da empresa). `active` = não suspensa nem removida. */
  lockCompany(companyId: CompanyId): Promise<{ readonly active: boolean }>;
  loadConfig(companyId: CompanyId): Promise<ContactScheduleConfig>;
  listBusy(
    companyId: CompanyId,
    resourceIds: readonly string[],
    from: Date,
    to: Date,
  ): Promise<BusyInterval[]>;
  /** Reserva **ativa** do mesmo contato, serviço e início (idempotência). */
  findActiveSame(
    companyId: CompanyId,
    contactRef: string,
    serviceId: string,
    startsAt: Date,
  ): Promise<Appointment | null>;
  /** Agendamento do contato por id, em qualquer estado; `null` se não é dele (ou não existe). */
  findForContact(
    companyId: CompanyId,
    contactRef: string,
    appointmentId: string,
  ): Promise<Appointment | null>;
  countActiveFutureByContact(
    companyId: CompanyId,
    contactRef: string,
    after: Date,
  ): Promise<number>;
  /** Criações do contato desde `since`, inclusive canceladas (contra "criar e cancelar em ciclo"). */
  countCreatedByContactSince(
    companyId: CompanyId,
    contactRef: string,
    since: Date,
  ): Promise<number>;
  /** Reservas ativas e futuras com origem CHANNEL da empresa, qualquer status. */
  countActiveChannelFuture(companyId: CompanyId, after: Date): Promise<number>;
  /** `PENDING` do canal (IA) ativos e futuros da empresa. */
  countPendingChannelFuture(companyId: CompanyId, after: Date): Promise<number>;
  /**
   * Cancela, como `CONTACT`, a reserva ativa do contato (`company_id`, `contact_ref` e `kind` no `where`).
   * `null` se não estava ativa ou não é do contato.
   */
  cancelForContact(
    companyId: CompanyId,
    contactRef: string,
    appointmentId: string,
    now: Date,
  ): Promise<Appointment | null>;
  /** Um único `INSERT`. Sobreposição = `ConflictError` `SLOT_TAKEN` (restrição do banco). */
  create(companyId: CompanyId, data: NewAppointment): Promise<Appointment>;
}

export interface ContactScheduleUnitOfWork {
  /** Transação com `statement_timeout` curto; qualquer erro lançado por `fn` desfaz tudo. */
  run<T>(fn: (tx: ContactScheduleTransaction) => Promise<T>): Promise<T>;
}

/**
 * Cotas de escrita da IA no Redis (spec 028, decisão 6): por contato e por empresa, janela de 24 h. As
 * chaves usam HMAC do contato (nunca o `contactRef` em claro). Redis fora = `ping` falha e, no meio do
 * turno, `take` lança `ServiceUnavailableError`: nenhuma escrita é feita.
 */
export interface ScheduleAiQuotaStore {
  /** Prova que o Redis das cotas responde (senão a IA fica em modo só leitura). */
  ping(): Promise<void>;
  /** Só confere (não consome) se há vaga para o contato e para a empresa. */
  check(
    companyId: CompanyId,
    contactKey: string,
  ): Promise<'ok' | 'contact_limit' | 'company_limit'>;
  /**
   * Consome, tudo-ou-nada, uma vaga do contato e uma da empresa. `ok`; `contact_limit` ou
   * `company_limit` (nada é consumido).
   */
  take(companyId: CompanyId, contactKey: string): Promise<'ok' | 'contact_limit' | 'company_limit'>;
}
