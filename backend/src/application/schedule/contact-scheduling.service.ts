import { createHmac } from 'node:crypto';
import {
  type Appointment,
  type CompanyId,
  SCHEDULE_AI_COMPANY_MAX_PENDING,
  SCHEDULE_AI_CONTACT_MAX_ACTIVE,
  SCHEDULE_AI_CONTACT_MAX_CREATIONS_PER_DAY,
  SCHEDULE_AI_MAX_ALTERNATIVES,
  SCHEDULE_AI_MAX_SERVICE_NAMES_RESULT,
  SCHEDULE_AI_COMPANY_MAX_ACTIVE_CHANNEL,
  SCHEDULE_AI_QUOTA_WINDOW_MS,
  SCHEDULE_MAX_ADVANCE_DAYS,
  type ScheduleServiceItem,
} from '../../domain/index.js';
import { ConflictError } from '../../shared/errors/index.js';
import { neutralize } from '../attendance/knowledge-prompt.js';
import { normalizeSearchText } from '../knowledge/normalize.js';
import type {
  ContactScheduleConfig,
  ContactScheduleTransaction,
  ContactScheduleUnitOfWork,
  ScheduleAiQuotaStore,
} from '../ports/contact-scheduling.js';
import { computeSlots, type Slot } from './availability.js';
import {
  addDays,
  daysBetween,
  formatLocalTime,
  isValidLocalDate,
  localPartsOf,
  parseLocalDateTime,
  zonedToInstant,
} from './zoned-time.js';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Janela (em dias, a partir do dia pedido) em que se procuram os horários alternativos. */
const ALTERNATIVES_WINDOW_DAYS = 7;

/** Um agendamento como a IA e o resumo o enxergam: serviço, data/hora local e estado (nunca id nem contato). */
export interface BookedView {
  readonly serviceName: string;
  readonly localDate: string;
  readonly localStart: string;
  readonly status: 'PENDING' | 'CONFIRMED';
}

export interface AlternativeSlot {
  readonly localDate: string;
  readonly localStart: string;
}

/** Resultado de uma escrita da IA. A razão detalhada vai só a métrica (enum), nunca a texto livre. */
export type ContactOutcome =
  | { readonly kind: 'booked'; readonly booked: BookedView; readonly already: boolean }
  | { readonly kind: 'cancelled'; readonly cancelled: BookedView; readonly already: boolean }
  | {
      readonly kind: 'rescheduled';
      readonly from: BookedView;
      readonly to: BookedView;
    }
  | { readonly kind: 'slot_taken'; readonly alternatives: readonly AlternativeSlot[] }
  | { readonly kind: 'outside_rules' }
  | { readonly kind: 'service_not_found'; readonly names: readonly string[] }
  | { readonly kind: 'not_found' }
  | {
      readonly kind: 'limit';
      readonly reason: 'active' | 'creations' | 'pending' | 'company_active' | 'quota';
    }
  | { readonly kind: 'unavailable' };

export interface RequestBookingArgs {
  readonly serviceName: string;
  /** `YYYY-MM-DDTHH:mm`, relógio da empresa. */
  readonly start: string;
  readonly customerLabel: string | null;
}

export interface RescheduleArgs {
  readonly appointmentId: string;
  readonly newStart: string;
}

/**
 * O que a IA pode fazer com a agenda (spec 028). A identidade (`companyId` e `contactRef`) vem **sempre**
 * de quem chama o atendimento, nunca do modelo; nenhum argumento é id. Cada operação é uma transação com a
 * linha da empresa travada; a garantia final contra dupla reserva é a restrição `EXCLUDE` do banco.
 */
export interface ContactScheduling {
  /** O Redis das cotas responde? Falso = a IA fica em modo só leitura (sem erro). */
  isAvailable(): Promise<boolean>;
  request(
    companyId: CompanyId,
    contactRef: string,
    args: RequestBookingArgs,
  ): Promise<ContactOutcome>;
  cancel(companyId: CompanyId, contactRef: string, appointmentId: string): Promise<ContactOutcome>;
  reschedule(
    companyId: CompanyId,
    contactRef: string,
    args: RescheduleArgs,
  ): Promise<ContactOutcome>;
}

export interface ContactSchedulingDeps {
  readonly unitOfWork: ContactScheduleUnitOfWork;
  readonly quota: ScheduleAiQuotaStore;
  /** Segredo da chave HMAC das cotas por contato (o `contactRef` nunca vai ao Redis em claro). */
  readonly quotaSecret: string | Buffer;
  /** Relógio injetável, para os testes. */
  readonly now?: () => Date;
  /** Só `companyId`, nome fixo da operação e `errorName`: nunca mensagem de erro, argumento, nome nem horário. */
  readonly logger?: { warn(fields: object, message: string): void };
}

/** Desfaz a transação carregando o resultado de regra de negócio (não é erro). */
class Rollback extends Error {
  constructor(readonly outcome: ContactOutcome) {
    super('rollback');
  }
}

export class ContactSchedulingService implements ContactScheduling {
  private readonly now: () => Date;

  constructor(private readonly deps: ContactSchedulingDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.deps.quota.ping();
      return true;
    } catch {
      return false;
    }
  }

  async request(
    companyId: CompanyId,
    contactRef: string,
    args: RequestBookingArgs,
  ): Promise<ContactOutcome> {
    const gate = await this.gate(companyId, contactRef, args.start);
    if (gate !== null) return gate;
    return this.settle(companyId, contactRef, await this.doRequest(companyId, contactRef, args));
  }

  private async doRequest(
    companyId: CompanyId,
    contactRef: string,
    args: RequestBookingArgs,
  ): Promise<ContactOutcome> {
    try {
      return await this.write(companyId, async (tx, config, now) => {
        const service = resolveService(config, args.serviceName);
        if (service.kind !== 'found') return service.outcome;
        return this.book(tx, config, now, {
          companyId,
          contactRef,
          service: service.item,
          start: args.start,
          customerLabel: args.customerLabel,
        });
      });
    } catch (error) {
      return this.afterWriteError(error, companyId, contactRef, args);
    }
  }

  async cancel(
    companyId: CompanyId,
    contactRef: string,
    appointmentId: string,
  ): Promise<ContactOutcome> {
    const gate = await this.gate(companyId, contactRef, null);
    if (gate !== null) return gate;
    return this.settle(
      companyId,
      contactRef,
      await this.doCancel(companyId, contactRef, appointmentId),
    );
  }

  private async doCancel(
    companyId: CompanyId,
    contactRef: string,
    appointmentId: string,
  ): Promise<ContactOutcome> {
    try {
      return await this.write(companyId, async (tx, config, now) => {
        const row = await tx.findForContact(companyId, contactRef, appointmentId);
        if (row === null || row.kind !== 'BOOKING') return { kind: 'not_found' };
        if (row.status === 'CANCELLED' && row.cancelledBy === 'CONTACT') {
          return { kind: 'cancelled', cancelled: view(row, config), already: true };
        }
        if (row.status !== 'PENDING' && row.status !== 'CONFIRMED') return { kind: 'not_found' };
        const changed = await tx.cancelForContact(companyId, contactRef, row.id, now);
        if (changed === null) return { kind: 'not_found' };
        return { kind: 'cancelled', cancelled: view(row, config), already: false };
      });
    } catch (error) {
      return this.unexpected(companyId, 'cancel', error);
    }
  }

  async reschedule(
    companyId: CompanyId,
    contactRef: string,
    args: RescheduleArgs,
  ): Promise<ContactOutcome> {
    const gate = await this.gate(companyId, contactRef, args.newStart);
    if (gate !== null) return gate;
    return this.settle(companyId, contactRef, await this.doReschedule(companyId, contactRef, args));
  }

  private async doReschedule(
    companyId: CompanyId,
    contactRef: string,
    args: RescheduleArgs,
  ): Promise<ContactOutcome> {
    try {
      return await this.write(companyId, async (tx, config, now) => {
        const old = await tx.findForContact(companyId, contactRef, args.appointmentId);
        if (
          old === null ||
          old.kind !== 'BOOKING' ||
          (old.status !== 'PENDING' && old.status !== 'CONFIRMED') ||
          old.serviceId === null
        ) {
          return { kind: 'not_found' };
        }
        const service = config.services.find((item) => item.id === old.serviceId && item.active);
        if (service === undefined) return { kind: 'not_found' };
        // O antigo é cancelado primeiro, na mesma transação: o novo horário pode, assim, sobrepor o dele.
        // Qualquer recusa abaixo desfaz o cancelamento (o antigo continua ativo).
        const cancelled = await tx.cancelForContact(companyId, contactRef, old.id, now);
        if (cancelled === null) return { kind: 'not_found' };
        const outcome = await this.book(tx, config, now, {
          companyId,
          contactRef,
          service,
          start: args.newStart,
          customerLabel: old.customerLabel,
        });
        if (outcome.kind !== 'booked') throw new Rollback(outcome);
        return { kind: 'rescheduled', from: view(old, config), to: outcome.booked };
      });
    } catch (error) {
      if (isSlotTaken(error)) {
        const alternatives = await this.alternativesFor(companyId, contactRef, args);
        return { kind: 'slot_taken', alternatives };
      }
      return this.unexpected(companyId, 'reschedule', error);
    }
  }

  /* ----------------------------------- interno ----------------------------------- */

  /**
   * Antes de qualquer transação: (1) início fora de uma faixa plausível (data inválida, extrema como 9999-12-31 ou
   * além do teto de dias da agenda) é `fora_do_horario` sem tocar em Redis nem banco; (2) a cota é só **conferida**
   * (nunca consumida aqui): Redis fora = `unavailable`, cota esgotada = `limit`.
   */
  private async gate(
    companyId: CompanyId,
    contactRef: string,
    start: string | null,
  ): Promise<ContactOutcome | null> {
    if (start !== null && startOutOfRange(start, this.now())) return { kind: 'outside_rules' };
    try {
      const result = await this.deps.quota.check(companyId, this.contactKey(companyId, contactRef));
      return result === 'ok' ? null : { kind: 'limit', reason: 'quota' };
    } catch (error) {
      this.warn(companyId, 'quota_check', error);
      return { kind: 'unavailable' };
    }
  }

  private contactKey(companyId: CompanyId, contactRef: string): string {
    return createHmac('sha256', this.deps.quotaSecret)
      .update(`schedule-ai-quota:${companyId}|${contactRef}`)
      .digest('hex');
  }

  /**
   * A cota é consumida **só** quando houve escrita efetiva (reserva criada, cancelada ou remarcada); tentativa sem
   * efeito (serviço, regra, ocupado, limite, repetição idempotente) não gasta cota. A escrita já está feita: falha
   * do Redis aqui só é registrada.
   */
  private async settle(
    companyId: CompanyId,
    contactRef: string,
    outcome: ContactOutcome,
  ): Promise<ContactOutcome> {
    const effective =
      (outcome.kind === 'booked' && !outcome.already) ||
      (outcome.kind === 'cancelled' && !outcome.already) ||
      outcome.kind === 'rescheduled';
    if (!effective) return outcome;
    try {
      await this.deps.quota.take(companyId, this.contactKey(companyId, contactRef));
    } catch (error) {
      this.warn(companyId, 'quota_take', error);
    }
    return outcome;
  }

  private warn(companyId: CompanyId, operation: string, error: unknown): void {
    try {
      this.deps.logger?.warn(
        { companyId, operation, errorName: error instanceof Error ? error.name : typeof error },
        'escrita da IA na agenda falhou sem resultado de regra',
      );
    } catch {
      // Log nunca derruba a operação.
    }
  }

  /**
   * Transação de escrita: trava a empresa, confirma que está ativa e que a IA ainda está ligada (o
   * interruptor pode ter sido desligado depois de o turno começar) e entrega a configuração lida **depois**
   * do bloqueio. Um `Rollback` vira o resultado dele; qualquer outro erro sobe.
   */
  private async write(
    companyId: CompanyId,
    fn: (
      tx: ContactScheduleTransaction,
      config: ContactScheduleConfig,
      now: Date,
    ) => Promise<ContactOutcome>,
  ): Promise<ContactOutcome> {
    try {
      return await this.deps.unitOfWork.run(async (tx) => {
        const company = await tx.lockCompany(companyId);
        if (!company.active) return { kind: 'unavailable' };
        const config = await tx.loadConfig(companyId);
        if (!config.aiBookingEnabled) return { kind: 'unavailable' };
        return fn(tx, config, this.now());
      });
    } catch (error) {
      if (error instanceof Rollback) return error.outcome;
      throw error;
    }
  }

  /** O que a IA solicita nasce `PENDING` (ou `CONFIRMED` com a opção da empresa). Só a regra; sem I/O de cota. */
  private async book(
    tx: ContactScheduleTransaction,
    config: ContactScheduleConfig,
    now: Date,
    input: {
      readonly companyId: CompanyId;
      readonly contactRef: string;
      readonly service: ScheduleServiceItem;
      readonly start: string;
      readonly customerLabel: string | null;
    },
  ): Promise<ContactOutcome> {
    const { companyId, contactRef, service } = input;
    const startsAt = parseLocalDateTime(input.start, config.timezone);
    // Horário que não existe (lacuna do horário de verão) ou já passou: fora das regras.
    if (startsAt === null || startsAt.getTime() < now.getTime()) return { kind: 'outside_rules' };

    const same = await tx.findActiveSame(companyId, contactRef, service.id, startsAt);
    if (same !== null) {
      return { kind: 'booked', booked: view(same, config), already: true };
    }

    const status = config.aiAutoConfirm ? 'CONFIRMED' : 'PENDING';
    if (
      (await tx.countActiveFutureByContact(companyId, contactRef, now)) >=
      SCHEDULE_AI_CONTACT_MAX_ACTIVE
    ) {
      return { kind: 'limit', reason: 'active' };
    }
    if (
      (await tx.countCreatedByContactSince(
        companyId,
        contactRef,
        new Date(now.getTime() - SCHEDULE_AI_QUOTA_WINDOW_MS),
      )) >= SCHEDULE_AI_CONTACT_MAX_CREATIONS_PER_DAY
    ) {
      return { kind: 'limit', reason: 'creations' };
    }
    if (
      status === 'PENDING' &&
      (await tx.countPendingChannelFuture(companyId, now)) >= SCHEDULE_AI_COMPANY_MAX_PENDING
    ) {
      return { kind: 'limit', reason: 'pending' };
    }

    // Teto de volume por empresa, independente do status (vale também com a confirmação automática).
    if (
      (await tx.countActiveChannelFuture(companyId, now)) >= SCHEDULE_AI_COMPANY_MAX_ACTIVE_CHANNEL
    ) {
      return { kind: 'limit', reason: 'company_active' };
    }

    const date = input.start.slice(0, 10);
    const free = await this.freeSlots(tx, companyId, config, service, now, date);
    const match = free.find((slot) => slot.startsAt.getTime() === startsAt.getTime());
    if (match === undefined) {
      // O horário está dentro das regras mas ocupado, ou fora delas?
      const ignoringBusy = computeFor(config, service, now, date, date, []);
      return ignoringBusy.some((slot) => slot.startsAt.getTime() === startsAt.getTime())
        ? { kind: 'slot_taken', alternatives: alternativesOf(free, startsAt) }
        : { kind: 'outside_rules' };
    }
    const created = await tx.create(companyId, {
      resourceId: match.resourceId,
      serviceId: service.id,
      kind: 'BOOKING',
      status,
      startsAt: match.startsAt,
      endsAt: match.endsAt,
      blockedUntil: new Date(match.endsAt.getTime() + service.bufferMinutes * MINUTE_MS),
      customerLabel: input.customerLabel,
      contactRef,
      source: 'CHANNEL',
      createdByMembershipId: null,
    });
    return { kind: 'booked', booked: view(created, config), already: false };
  }

  /** Horários livres a partir do dia pedido (janela para as alternativas), com os itens ocupados lidos agora. */
  private async freeSlots(
    tx: ContactScheduleTransaction,
    companyId: CompanyId,
    config: ContactScheduleConfig,
    service: ScheduleServiceItem,
    now: Date,
    date: string,
  ): Promise<Slot[]> {
    const ids = config.resources.map((resource) => resource.id);
    if (ids.length === 0) return [];
    const base = (
      zonedToInstant(date, 0, config.timezone) ??
      zonedToInstant(date, 60, config.timezone) ??
      now
    ).getTime();
    const busy = await tx.listBusy(
      companyId,
      ids,
      new Date(base - DAY_MS),
      new Date(base + (ALTERNATIVES_WINDOW_DAYS + 2) * DAY_MS),
    );
    return computeFor(
      config,
      service,
      now,
      date,
      addDays(date, ALTERNATIVES_WINDOW_DAYS - 1),
      busy,
    );
  }

  /**
   * A restrição do banco recusou a gravação (dupla reserva). Se o item que ocupa o horário é **a própria
   * reserva** deste contato (corrida contra ele mesmo ou repetição), é `ok`; senão, `slot_ocupado` com
   * alternativas. Roda numa transação nova (a anterior foi desfeita).
   */
  private async afterWriteError(
    error: unknown,
    companyId: CompanyId,
    contactRef: string,
    args: RequestBookingArgs,
  ): Promise<ContactOutcome> {
    if (!isSlotTaken(error)) return this.unexpected(companyId, 'request', error);
    try {
      return await this.write(companyId, async (tx, config, now) => {
        const service = resolveService(config, args.serviceName);
        if (service.kind !== 'found') return { kind: 'slot_taken', alternatives: [] };
        const startsAt = parseLocalDateTime(args.start, config.timezone);
        if (startsAt === null) return { kind: 'slot_taken', alternatives: [] };
        const same = await tx.findActiveSame(companyId, contactRef, service.item.id, startsAt);
        if (same !== null) return { kind: 'booked', booked: view(same, config), already: true };
        const free = await this.freeSlots(
          tx,
          companyId,
          config,
          service.item,
          now,
          args.start.slice(0, 10),
        );
        return { kind: 'slot_taken', alternatives: alternativesOf(free, startsAt) };
      });
    } catch (error) {
      this.warn(companyId, 'request_recover', error);
      return { kind: 'slot_taken', alternatives: [] };
    }
  }

  private async alternativesFor(
    companyId: CompanyId,
    contactRef: string,
    args: RescheduleArgs,
  ): Promise<readonly AlternativeSlot[]> {
    try {
      const outcome = await this.write(companyId, async (tx, config, now) => {
        const startsAt = parseLocalDateTime(args.newStart, config.timezone);
        const old = await tx.findForContact(companyId, contactRef, args.appointmentId);
        const service = config.services.find((item) => item.id === old?.serviceId && item.active);
        if (startsAt === null || service === undefined)
          return { kind: 'slot_taken', alternatives: [] };
        const free = await this.freeSlots(
          tx,
          companyId,
          config,
          service,
          now,
          args.newStart.slice(0, 10),
        );
        return { kind: 'slot_taken', alternatives: alternativesOf(free, startsAt) };
      });
      return outcome.kind === 'slot_taken' ? outcome.alternatives : [];
    } catch (error) {
      this.warn(companyId, 'reschedule_recover', error);
      return [];
    }
  }

  /** Erro que não é de regra: a IA recebe `indisponivel`; nada do erro vai adiante. */
  private unexpected(companyId: CompanyId, operation: string, error: unknown): ContactOutcome {
    this.warn(companyId, operation, error);
    return { kind: 'unavailable' };
  }
}

/** Início implausível: data inválida ou fora de [ontem, hoje + teto de dias da agenda + 1] (calendário UTC). */
function startOutOfRange(start: string, now: Date): boolean {
  const date = start.slice(0, 10);
  if (!isValidLocalDate(date)) return true;
  const distance = daysBetween(now.toISOString().slice(0, 10), date);
  return distance < -1 || distance > SCHEDULE_MAX_ADVANCE_DAYS + 1;
}

function isSlotTaken(error: unknown): boolean {
  return error instanceof ConflictError && error.code === 'SLOT_TAKEN';
}

type ResolvedService =
  | { readonly kind: 'found'; readonly item: ScheduleServiceItem }
  | { readonly kind: 'missing'; readonly outcome: ContactOutcome };

/** Serviço **ativo** pelo nome (sem acento e sem diferença de maiúscula); nenhum ou mais de um = não achado. */
function resolveService(config: ContactScheduleConfig, name: string): ResolvedService {
  const wanted = normalizeSearchText(neutralize(name)).replace(/\s+/g, ' ').trim();
  const active = config.services.filter((item) => item.active);
  const matches = active.filter(
    (item) => normalizeSearchText(neutralize(item.name)).replace(/\s+/g, ' ').trim() === wanted,
  );
  const [item] = matches;
  if (item !== undefined && matches.length === 1) return { kind: 'found', item };
  return {
    kind: 'missing',
    outcome: {
      kind: 'service_not_found',
      names: active.slice(0, SCHEDULE_AI_MAX_SERVICE_NAMES_RESULT).map((entry) => entry.name),
    },
  };
}

function computeFor(
  config: ContactScheduleConfig,
  service: ScheduleServiceItem,
  now: Date,
  fromDate: string,
  toDate: string,
  busy: Parameters<typeof computeSlots>[0]['busy'],
): Slot[] {
  return computeSlots({
    timezone: config.timezone,
    slotStepMinutes: config.slotStepMinutes,
    minNoticeMinutes: config.minNoticeMinutes,
    maxAdvanceDays: config.maxAdvanceDays,
    service,
    resources: config.resources.map((resource) => ({ id: resource.id, windows: resource.windows })),
    busy,
    now,
    fromDate,
    toDate,
  });
}

/** Até 3 horários livres distintos, os mais próximos do pedido, em ordem cronológica. */
function alternativesOf(free: readonly Slot[], around: Date): AlternativeSlot[] {
  const seen = new Set<string>();
  const distinct: Slot[] = [];
  for (const slot of free) {
    const key = `${slot.localDate} ${slot.localStart}`;
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(slot);
  }
  return distinct
    .toSorted(
      (left, right) =>
        Math.abs(left.startsAt.getTime() - around.getTime()) -
        Math.abs(right.startsAt.getTime() - around.getTime()),
    )
    .slice(0, SCHEDULE_AI_MAX_ALTERNATIVES)
    .toSorted((left, right) => left.startsAt.getTime() - right.startsAt.getTime())
    .map((slot) => ({ localDate: slot.localDate, localStart: slot.localStart }));
}

function view(row: Appointment, config: ContactScheduleConfig): BookedView {
  const service = config.services.find((item) => item.id === row.serviceId);
  return {
    serviceName: service?.name ?? '',
    localDate: localPartsOf(row.startsAt, config.timezone).date,
    localStart: formatLocalTime(row.startsAt, config.timezone),
    status: row.status === 'CONFIRMED' ? 'CONFIRMED' : 'PENDING',
  };
}
