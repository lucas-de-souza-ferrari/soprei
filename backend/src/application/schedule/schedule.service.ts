import {
  type Appointment,
  type AppointmentRepository,
  type AppointmentStatus,
  type AvailabilityRuleRepository,
  type AvailabilityWindow,
  canTransition,
  type CompanyId,
  type ScheduleResource,
  type ScheduleResourceRepository,
  type ScheduleServiceItem,
  type ScheduleServiceRepository,
  type ScheduleSettings,
  type ScheduleSettingsRepository,
  isActiveStatus,
  SCHEDULE_APPOINTMENTS_MAX_DAYS,
  SCHEDULE_APPOINTMENTS_MAX_ITEMS,
  SCHEDULE_AVAILABILITY_MAX_DAYS,
  SCHEDULE_MAX_ACTIVE_FUTURE,
  SCHEDULE_MAX_RESOURCES,
  SCHEDULE_MAX_SERVICES,
  SCHEDULE_MAX_WINDOWS_PER_DAY,
} from '../../domain/index.js';
import type { ScheduleAction, ScheduleActionResult } from '../../infrastructure/metrics/index.js';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors/index.js';
import { isUuid } from '../../shared/utils/index.js';
import { describeContact } from '../attendance/contact-label.js';
import { computeSlots } from './availability.js';
import type {
  AppointmentsQuery,
  AvailabilityQuery,
  CreateAppointmentBody,
  CreateBlocksBody,
  PatchAppointmentBody,
  ResourceInput,
  ResourcePatch,
  ServiceInput,
  ServicePatch,
  SettingsBody,
} from './schedule.schemas.js';
import {
  addDays,
  daysBetween,
  formatLocalTime,
  isValidTimeZone,
  localPartsOf,
  parseLocalDateTime,
  zonedToInstant,
} from './zoned-time.js';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export const SLOT_TAKEN = 'SLOT_TAKEN';
export const IN_THE_PAST = 'IN_THE_PAST';
export const INVALID_TRANSITION = 'INVALID_TRANSITION';
export const RESOURCE_HAS_APPOINTMENTS = 'RESOURCE_HAS_APPOINTMENTS';
export const SCHEDULE_LIMIT_REACHED = 'SCHEDULE_LIMIT_REACHED';
export const RANGE_TOO_LARGE = 'RANGE_TOO_LARGE';

export interface ScheduleMetrics {
  countScheduleAction?(action: ScheduleAction, result: ScheduleActionResult): void;
}

/** O que o serviço precisa do logger: só ids, ação e resultado (nunca nome, rótulo, contato nem horário). */
export interface ScheduleLogger {
  info(fields: object, message: string): void;
}

export interface ScheduleDeps {
  readonly settings: ScheduleSettingsRepository;
  readonly resources: ScheduleResourceRepository;
  readonly services: ScheduleServiceRepository;
  readonly rules: AvailabilityRuleRepository;
  readonly appointments: AppointmentRepository;
  readonly logger: ScheduleLogger;
  readonly metrics?: ScheduleMetrics | undefined;
  /** Relógio injetável, para os testes. */
  readonly now?: () => Date;
}

export interface LocalFields {
  readonly localDate: string;
  readonly localStart: string;
  readonly localEnd: string;
  readonly weekday: number;
}

export interface AppointmentView extends LocalFields {
  readonly id: string;
  readonly kind: Appointment['kind'];
  readonly status: AppointmentStatus;
  readonly source: Appointment['source'];
  readonly resourceId: string;
  readonly resourceName: string | null;
  readonly serviceId: string | null;
  readonly serviceName: string | null;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly customerLabel: string | null;
  /** Rótulo mascarado da 024 (`Contato final 1234`); **nunca** o `contactRef`. */
  readonly contactLabel: string | null;
  readonly createdAt: Date;
}

export interface ResourceView extends ScheduleResource {
  readonly windows: readonly { weekday: number; start: string; end: string }[];
}

export interface SlotView extends LocalFields {
  readonly resourceId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

const hhmm = (minute: number): string =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

/** Início do dia local (00:00; se esse horário não existe, 01:00). */
function startOfLocalDay(date: string, timezone: string): Date {
  return zonedToInstant(date, 0, timezone) ?? zonedToInstant(date, 60, timezone) ?? new Date(NaN);
}

/** Janelas do mesmo dia não se sobrepõem e são no máximo `SCHEDULE_MAX_WINDOWS_PER_DAY`. */
export function validateWindows(windows: readonly AvailabilityWindow[]): void {
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    const day = windows
      .filter((window) => window.weekday === weekday)
      .sort((left, right) => left.startMinute - right.startMinute);
    if (day.length > SCHEDULE_MAX_WINDOWS_PER_DAY) {
      throw new ValidationError('Janelas demais no mesmo dia', { code: 'INVALID_WINDOWS' });
    }
    for (let index = 1; index < day.length; index += 1) {
      const previous = day[index - 1];
      const current = day[index];
      if (
        previous !== undefined &&
        current !== undefined &&
        current.startMinute < previous.endMinute
      ) {
        throw new ValidationError('Janelas sobrepostas no mesmo dia', { code: 'INVALID_WINDOWS' });
      }
    }
  }
}

/**
 * Agenda da empresa (spec 027). O `CompanyId` vem sempre da identidade autenticada. Nome de serviço,
 * `customerLabel`, contato e horários de agendamento nunca vão a log nem a métrica: só ids, ação e
 * resultado. A dupla reserva é impedida pelo banco (`SLOT_TAKEN`); a lista de horários livres é só
 * sugestão.
 */
export class ScheduleService {
  private readonly now: () => Date;

  constructor(private readonly deps: ScheduleDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private count(action: ScheduleAction, result: ScheduleActionResult): void {
    try {
      this.deps.metrics?.countScheduleAction?.(action, result);
    } catch {
      // Métrica nunca derruba a operação.
    }
  }

  /** Executa `fn` registrando o resultado na métrica (`slot_taken`, `conflict`, `invalid`, `ok`). */
  private async track<T>(action: ScheduleAction, fn: () => Promise<T>): Promise<T> {
    try {
      const value = await fn();
      this.count(action, 'ok');
      return value;
    } catch (error) {
      if (error instanceof ConflictError) {
        this.count(action, error.code === SLOT_TAKEN ? 'slot_taken' : 'conflict');
      } else if (error instanceof ValidationError) {
        this.count(action, 'invalid');
      }
      throw error;
    }
  }

  /* ------------------------------- configurações ------------------------------- */

  getSettings(companyId: CompanyId): Promise<ScheduleSettings> {
    return this.deps.settings.ensure(companyId);
  }

  updateSettings(companyId: CompanyId, body: SettingsBody): Promise<ScheduleSettings> {
    return this.track('configure', async () => {
      if (!isValidTimeZone(body.timezone)) {
        throw new ValidationError('Fuso horário inválido', { code: 'INVALID_TIMEZONE' });
      }
      return this.deps.settings.update(companyId, body);
    });
  }

  /* --------------------------------- recursos ---------------------------------- */

  async listResources(companyId: CompanyId): Promise<ResourceView[]> {
    await this.deps.settings.ensure(companyId); // cria a "Agenda principal" na primeira vez
    const resources = await this.deps.resources.list(companyId);
    const rules = await this.deps.rules.listForResources(
      companyId,
      resources.map((resource) => resource.id),
    );
    return resources.map((resource) => ({
      ...resource,
      windows: rules
        .filter((rule) => rule.resourceId === resource.id)
        .map((rule) => ({
          weekday: rule.weekday,
          start: hhmm(rule.startMinute),
          end: hhmm(rule.endMinute),
        })),
    }));
  }

  createResource(companyId: CompanyId, input: ResourceInput): Promise<ScheduleResource> {
    return this.track('configure', async () => {
      await this.deps.settings.ensure(companyId);
      const current = await this.deps.resources.list(companyId);
      if (current.length >= SCHEDULE_MAX_RESOURCES) {
        throw new ConflictError('Limite de recursos atingido', { code: SCHEDULE_LIMIT_REACHED });
      }
      const position = current.reduce((max, resource) => Math.max(max, resource.position), -1) + 1;
      return this.deps.resources.create(companyId, { name: input.name, position });
    });
  }

  updateResource(
    companyId: CompanyId,
    resourceId: string,
    patch: ResourcePatch,
  ): Promise<ScheduleResource> {
    return this.track('configure', async () => {
      const current = await this.deps.resources.findById(companyId, resourceId);
      if (patch.active === false && current.active) {
        // Melhor esforço sob concorrência: um agendamento criado neste instante pode escapar da checagem.
        const future = await this.deps.appointments.countActiveFuture(companyId, this.now(), {
          resourceId: current.id,
          kind: 'BOOKING',
        });
        if (future > 0) {
          throw new ConflictError('O recurso tem agendamentos futuros', {
            code: RESOURCE_HAS_APPOINTMENTS,
          });
        }
      }
      return this.deps.resources.update(companyId, resourceId, patch);
    });
  }

  /** Substitui as janelas semanais do recurso. Não cancela nem move agendamento existente. */
  setRules(
    companyId: CompanyId,
    resourceId: string,
    windows: readonly { weekday: number; start: number; end: number }[],
  ): Promise<ResourceView> {
    return this.track('configure', async () => {
      await this.deps.resources.findById(companyId, resourceId);
      const parsed = windows.map((window) => ({
        weekday: window.weekday,
        startMinute: window.start,
        endMinute: window.end,
      }));
      validateWindows(parsed);
      await this.deps.rules.replaceForResource(companyId, resourceId, parsed);
      const view = (await this.listResources(companyId)).find((item) => item.id === resourceId);
      if (view === undefined) throw new NotFoundError('Recurso não encontrado');
      return view;
    });
  }

  /* --------------------------------- serviços ---------------------------------- */

  listServices(companyId: CompanyId): Promise<ScheduleServiceItem[]> {
    return this.deps.services.list(companyId);
  }

  createService(companyId: CompanyId, input: ServiceInput): Promise<ScheduleServiceItem> {
    return this.track('configure', async () => {
      const current = await this.deps.services.list(companyId);
      if (current.length >= SCHEDULE_MAX_SERVICES) {
        throw new ConflictError('Limite de serviços atingido', { code: SCHEDULE_LIMIT_REACHED });
      }
      return this.deps.services.create(companyId, input);
    });
  }

  /** Desativar um serviço não cancela agendamento nenhum: só deixa de ser oferecido. */
  updateService(
    companyId: CompanyId,
    serviceId: string,
    patch: ServicePatch,
  ): Promise<ScheduleServiceItem> {
    return this.track('configure', () => this.deps.services.update(companyId, serviceId, patch));
  }

  /* ------------------------------ horários livres ------------------------------ */

  async availability(
    companyId: CompanyId,
    query: AvailabilityQuery,
  ): Promise<{ timezone: string; generatedAt: Date; slots: SlotView[] }> {
    const settings = await this.deps.settings.ensure(companyId);
    const span = daysBetween(query.from, query.to);
    if (span < 0) throw new ValidationError('Intervalo inválido');
    if (span + 1 > SCHEDULE_AVAILABILITY_MAX_DAYS) {
      throw new ValidationError('Intervalo grande demais', { code: RANGE_TOO_LARGE });
    }
    const service = await this.deps.services.findById(companyId, query.serviceId);
    const now = this.now();
    const empty = { timezone: settings.timezone, generatedAt: now, slots: [] as SlotView[] };
    if (!service.active) return empty;
    const resources =
      query.resourceId === undefined
        ? (await this.deps.resources.list(companyId)).filter((resource) => resource.active)
        : [await this.deps.resources.findById(companyId, query.resourceId)].filter(
            (resource) => resource.active,
          );
    if (resources.length === 0) return empty;
    const ids = resources.map((resource) => resource.id);
    const rules = await this.deps.rules.listForResources(companyId, ids);
    const base = startOfLocalDay(query.from, settings.timezone).getTime();
    const busy = await this.deps.appointments.listBusy(
      companyId,
      ids,
      new Date(base - DAY_MS),
      new Date(base + (span + 3) * DAY_MS),
    );
    const slots = computeSlots({
      timezone: settings.timezone,
      slotStepMinutes: settings.slotStepMinutes,
      minNoticeMinutes: settings.minNoticeMinutes,
      maxAdvanceDays: settings.maxAdvanceDays,
      service,
      resources: resources.map((resource) => ({
        id: resource.id,
        windows: rules.filter((rule) => rule.resourceId === resource.id),
      })),
      busy,
      now,
      fromDate: query.from,
      toDate: query.to,
    });
    return {
      timezone: settings.timezone,
      generatedAt: now,
      slots: slots.map((slot) => ({
        resourceId: slot.resourceId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        localDate: slot.localDate,
        localStart: slot.localStart,
        localEnd: slot.localEnd,
        weekday: localPartsOf(slot.startsAt, settings.timezone).weekday,
      })),
    };
  }

  /* ------------------------------- agendamentos -------------------------------- */

  async listAppointments(
    companyId: CompanyId,
    query: AppointmentsQuery,
  ): Promise<{ timezone: string; items: AppointmentView[] }> {
    const settings = await this.deps.settings.ensure(companyId);
    const span = daysBetween(query.from, query.to);
    if (span < 0) throw new ValidationError('Intervalo inválido');
    if (span + 1 > SCHEDULE_APPOINTMENTS_MAX_DAYS) {
      throw new ValidationError('Intervalo grande demais', { code: RANGE_TOO_LARGE });
    }
    for (const id of [query.resourceId, query.serviceId]) {
      if (id !== undefined && !isUuid(id)) throw new NotFoundError('Recurso não encontrado');
    }
    const rows = await this.deps.appointments.list(companyId, {
      from: startOfLocalDay(query.from, settings.timezone),
      to: startOfLocalDay(addDays(query.to, 1), settings.timezone),
      resourceId: query.resourceId,
      serviceId: query.serviceId,
      status: query.status,
      limit: SCHEDULE_APPOINTMENTS_MAX_ITEMS + 1,
    });
    // Nunca truncar em silêncio: acima do teto, o cliente estreita o intervalo.
    if (rows.length > SCHEDULE_APPOINTMENTS_MAX_ITEMS) {
      throw new ValidationError('Muitos agendamentos no período', { code: RANGE_TOO_LARGE });
    }
    const [resources, services] = await Promise.all([
      this.deps.resources.list(companyId),
      this.deps.services.list(companyId),
    ]);
    return {
      timezone: settings.timezone,
      items: rows.map((row) => this.toView(row, settings.timezone, resources, services)),
    };
  }

  private toView(
    row: Appointment,
    timezone: string,
    resources: readonly ScheduleResource[],
    services: readonly ScheduleServiceItem[],
  ): AppointmentView {
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      source: row.source,
      resourceId: row.resourceId,
      resourceName: resources.find((resource) => resource.id === row.resourceId)?.name ?? null,
      serviceId: row.serviceId,
      serviceName: services.find((service) => service.id === row.serviceId)?.name ?? null,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      ...this.localFields(row.startsAt, row.endsAt, timezone),
      customerLabel: row.customerLabel,
      contactLabel:
        row.contactRef === null
          ? null
          : describeContact(row.companyId, row.contactRef).contactLabel,
      createdAt: row.createdAt,
    };
  }

  private localFields(startsAt: Date, endsAt: Date, timezone: string): LocalFields {
    const start = localPartsOf(startsAt, timezone);
    return {
      localDate: start.date,
      localStart: hhmm(start.minute),
      localEnd: formatLocalTime(endsAt, timezone),
      weekday: start.weekday,
    };
  }

  /** Visão de agendamentos já gravados (nomes buscados na hora, uma vez só). */
  async viewMany(companyId: CompanyId, rows: readonly Appointment[]): Promise<AppointmentView[]> {
    const settings = await this.deps.settings.ensure(companyId);
    const [resources, services] = await Promise.all([
      this.deps.resources.list(companyId),
      this.deps.services.list(companyId),
    ]);
    return rows.map((row) => this.toView(row, settings.timezone, resources, services));
  }

  async view(companyId: CompanyId, row: Appointment): Promise<AppointmentView> {
    const [view] = await this.viewMany(companyId, [row]);
    if (view === undefined) throw new NotFoundError('Recurso não encontrado');
    return view;
  }

  /** `startsAt` ou `localStart` (relógio da empresa, interpretado aqui): sempre um instante UTC. */
  private resolveInstant(
    instant: string | undefined,
    local: string | undefined,
    timezone: string,
  ): Date {
    if (instant !== undefined) return new Date(instant);
    const parsed = local === undefined ? null : parseLocalDateTime(local, timezone);
    if (parsed === null) {
      throw new ValidationError('Horário local inexistente ou inválido', {
        code: 'INVALID_LOCAL_TIME',
      });
    }
    return parsed;
  }

  private async assertRoom(companyId: CompanyId, now: Date): Promise<void> {
    const active = await this.deps.appointments.countActiveFuture(companyId, now);
    if (active >= SCHEDULE_MAX_ACTIVE_FUTURE) {
      throw new ConflictError('Limite de agendamentos atingido', { code: SCHEDULE_LIMIT_REACHED });
    }
  }

  /**
   * Reserva pelo painel: pode ser fora das regras semanais e dentro da antecedência mínima, nunca no
   * passado e nunca sobre outro item (a restrição do banco vale para todos).
   */
  createAppointment(
    companyId: CompanyId,
    membershipId: string,
    body: CreateAppointmentBody,
  ): Promise<Appointment> {
    return this.track('create', async () => {
      const settings = await this.deps.settings.ensure(companyId);
      const service = await this.deps.services.findById(companyId, body.serviceId);
      const resource = await this.deps.resources.findById(companyId, body.resourceId);
      if (!service.active)
        throw new ConflictError('Serviço desativado', { code: 'SERVICE_INACTIVE' });
      if (!resource.active)
        throw new ConflictError('Recurso desativado', { code: 'RESOURCE_INACTIVE' });
      const now = this.now();
      const startsAt = this.resolveInstant(body.startsAt, body.localStart, settings.timezone);
      if (startsAt.getTime() < now.getTime()) {
        throw new ValidationError('Horário no passado', { code: IN_THE_PAST });
      }
      await this.assertRoom(companyId, now);
      const endsAt = new Date(startsAt.getTime() + service.durationMinutes * MINUTE_MS);
      const blockedUntil = new Date(endsAt.getTime() + service.bufferMinutes * MINUTE_MS);
      const created = await this.deps.appointments.create(companyId, {
        resourceId: resource.id,
        serviceId: service.id,
        kind: 'BOOKING',
        status: body.status ?? 'CONFIRMED',
        startsAt,
        endsAt,
        blockedUntil,
        customerLabel: body.customerLabel ?? null,
        contactRef: null,
        source: 'PANEL',
        createdByMembershipId: membershipId,
      });
      this.deps.logger.info(
        { companyId, membershipId, appointmentId: created.id, action: 'create' },
        'agendamento criado',
      );
      return created;
    });
  }

  /** Um só tipo de mudança por chamada: estado, remarcação ou rótulo do cliente. */
  async updateAppointment(
    companyId: CompanyId,
    membershipId: string,
    appointmentId: string,
    body: PatchAppointmentBody,
  ): Promise<Appointment> {
    const current = await this.deps.appointments.findById(companyId, appointmentId);
    if (body.status !== undefined) {
      return this.changeStatus(companyId, membershipId, current, body.status);
    }
    if (body.customerLabel !== undefined) {
      return this.track('label', () =>
        this.deps.appointments.updateCustomerLabel(
          companyId,
          current.id,
          body.customerLabel ?? null,
        ),
      );
    }
    return this.reschedule(companyId, membershipId, current, body);
  }

  private changeStatus(
    companyId: CompanyId,
    membershipId: string,
    current: Appointment,
    target: AppointmentStatus,
  ): Promise<Appointment> {
    const action: ScheduleAction =
      target === 'CANCELLED'
        ? 'cancel'
        : target === 'CONFIRMED'
          ? 'confirm'
          : target === 'COMPLETED'
            ? 'complete'
            : 'no_show';
    return this.track(action, async () => {
      // Repetir o mesmo estado é idempotente (cancelamento duplicado, confirmação duplicada).
      if (current.status === target) return current;
      const now = this.now();
      const allowed =
        canTransition(current.status, target) &&
        (current.kind === 'BOOKING' || target === 'CANCELLED') &&
        ((target !== 'COMPLETED' && target !== 'NO_SHOW') ||
          current.startsAt.getTime() <= now.getTime());
      if (!allowed) throw invalidTransition();
      const changed = await this.deps.appointments.transition(companyId, current.id, {
        from: current.status,
        to: target,
        now,
        ...(target === 'CANCELLED' ? { cancelledBy: 'PANEL' as const } : {}),
      });
      if (changed === null) {
        // Outra mudança chegou primeiro: se já está no estado pedido, é o mesmo resultado.
        const latest = await this.deps.appointments.findById(companyId, current.id);
        if (latest.status === target) return latest;
        throw invalidTransition();
      }
      this.deps.logger.info(
        { companyId, membershipId, appointmentId: current.id, action, to: target },
        'agendamento mudou de estado',
      );
      return changed;
    });
  }

  private reschedule(
    companyId: CompanyId,
    membershipId: string,
    current: Appointment,
    body: PatchAppointmentBody,
  ): Promise<Appointment> {
    return this.track('reschedule', async () => {
      if (current.kind !== 'BOOKING' || !isActiveStatus(current.status)) throw invalidTransition();
      const settings = await this.deps.settings.ensure(companyId);
      const now = this.now();
      const startsAt = this.resolveInstant(body.startsAt, body.localStart, settings.timezone);
      if (startsAt.getTime() < now.getTime()) {
        throw new ValidationError('Horário no passado', { code: IN_THE_PAST });
      }
      // Mantém a duração e o intervalo gravados (o do serviço na hora da reserva).
      const duration = current.endsAt.getTime() - current.startsAt.getTime();
      const buffer = current.blockedUntil.getTime() - current.endsAt.getTime();
      const endsAt = new Date(startsAt.getTime() + duration);
      const changed = await this.deps.appointments.reschedule(companyId, current.id, {
        startsAt,
        endsAt,
        blockedUntil: new Date(endsAt.getTime() + buffer),
      });
      if (changed === null) throw invalidTransition();
      this.deps.logger.info(
        { companyId, membershipId, appointmentId: current.id, action: 'reschedule' },
        'agendamento remarcado',
      );
      return changed;
    });
  }

  /* --------------------------------- bloqueios --------------------------------- */

  /** Um bloqueio por recurso, tudo ou nada. Sobre um agendamento ativo: `SLOT_TAKEN`. */
  createBlocks(
    companyId: CompanyId,
    membershipId: string,
    body: CreateBlocksBody,
  ): Promise<Appointment[]> {
    return this.track('block', async () => {
      const settings = await this.deps.settings.ensure(companyId);
      const now = this.now();
      const startsAt = this.resolveInstant(body.startsAt, body.localStart, settings.timezone);
      const endsAt = this.resolveInstant(body.endsAt, body.localEnd, settings.timezone);
      if (endsAt.getTime() <= startsAt.getTime()) {
        throw new ValidationError('O fim deve ser depois do início', { code: 'INVALID_RANGE' });
      }
      if (endsAt.getTime() <= now.getTime()) {
        throw new ValidationError('Horário no passado', { code: IN_THE_PAST });
      }
      const ids = [...new Set(body.resourceIds)];
      for (const id of ids) {
        const resource = await this.deps.resources.findById(companyId, id);
        if (!resource.active) {
          throw new ConflictError('Recurso desativado', { code: 'RESOURCE_INACTIVE' });
        }
      }
      await this.assertRoom(companyId, now);
      const created = await this.deps.appointments.createMany(
        companyId,
        ids.map((resourceId) => ({
          resourceId,
          serviceId: null,
          kind: 'BLOCK' as const,
          status: 'CONFIRMED' as const,
          startsAt,
          endsAt,
          blockedUntil: endsAt,
          customerLabel: null,
          contactRef: null,
          source: 'PANEL' as const,
          createdByMembershipId: membershipId,
        })),
      );
      this.deps.logger.info(
        { companyId, membershipId, blocks: created.length, action: 'block' },
        'bloqueio criado',
      );
      return created;
    });
  }

  /** Cancela o bloqueio (idempotente). Id de um agendamento (não bloqueio) é 404 uniforme. */
  cancelBlock(companyId: CompanyId, membershipId: string, blockId: string): Promise<void> {
    return this.track('unblock', async () => {
      const current = await this.deps.appointments.findById(companyId, blockId);
      if (current.kind !== 'BLOCK') throw new NotFoundError('Recurso não encontrado');
      if (current.status === 'CANCELLED') return;
      const changed = await this.deps.appointments.transition(companyId, current.id, {
        from: current.status,
        to: 'CANCELLED',
        now: this.now(),
        cancelledBy: 'PANEL',
      });
      if (changed !== null) {
        this.deps.logger.info(
          { companyId, membershipId, appointmentId: current.id, action: 'unblock' },
          'bloqueio removido',
        );
      }
    });
  }
}

function invalidTransition(): ConflictError {
  return new ConflictError('Mudança de estado não permitida', { code: INVALID_TRANSITION });
}
