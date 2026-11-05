import {
  ACTIVE_APPOINTMENT_STATUSES,
  type Appointment,
  type AppointmentFilter,
  type AppointmentKind,
  type AppointmentRepository,
  type AppointmentStatus,
  type AvailabilityRuleItem,
  type AvailabilityRuleRepository,
  type AvailabilityWindow,
  type BusyInterval,
  type CompanyId,
  CompanyId as CompanyIdFactory,
  type NewAppointment,
  type NewScheduleService,
  SCHEDULE_MAIN_RESOURCE_NAME,
  type ScheduleResource,
  type ScheduleResourceRepository,
  type ScheduleServiceItem,
  type ScheduleServiceRepository,
  type ScheduleServiceUpdate,
  type ScheduleSettings,
  type ScheduleSettingsRepository,
  type ScheduleSettingsUpdate,
} from '../../../domain/index.js';
import { ConflictError, DatabaseError, NotFoundError } from '../../../shared/errors/index.js';
import { isUuid } from '../../../shared/utils/index.js';
import { Prisma } from '../../../generated/prisma/client.js';
import { isExclusionViolation } from '../database-errors.js';
import type { TenantScopedDb, TenantScopedPrisma } from '../extensions/tenant-scope.js';
import { runInTransaction } from '../transaction.js';
import { withRepositoryErrors } from './repository-errors.js';

const notFound = (entity: string): NotFoundError =>
  new NotFoundError('Recurso não encontrado', { context: { entity } });

/** Mensagem constante: não diz de quem é o horário nem qual item colidiu. */
export const SLOT_TAKEN_MESSAGE = 'Horário indisponível';

const slotTaken = (): ConflictError =>
  new ConflictError(SLOT_TAKEN_MESSAGE, { code: 'SLOT_TAKEN' });

/**
 * **Único** ponto que traduz a restrição de exclusão do banco (SQLSTATE 23P01) em `SLOT_TAKEN`.
 * Deadlock (P2034) que sobrou depois das repetições do `runInTransaction` também vira `SLOT_TAKEN`
 * (só aparece em remarcações cruzadas). Qualquer outro erro sobe como está.
 */
function toSlotTaken(error: unknown): unknown {
  if (error instanceof ConflictError) return error;
  if (isExclusionViolation(error)) return slotTaken();
  const cause = error instanceof DatabaseError ? error.cause : error;
  if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === 'P2034') {
    return slotTaken();
  }
  return error;
}

async function guardSlot<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toSlotTaken(error);
  }
}

/* ----------------------------------- configurações ----------------------------------- */

interface SettingsRow {
  readonly companyId: string;
  readonly timezone: string;
  readonly slotStepMinutes: number;
  readonly minNoticeMinutes: number;
  readonly maxAdvanceDays: number;
}

function toSettings(row: SettingsRow): ScheduleSettings {
  return {
    companyId: CompanyIdFactory.parse(row.companyId),
    timezone: row.timezone,
    slotStepMinutes: row.slotStepMinutes,
    minNoticeMinutes: row.minNoticeMinutes,
    maxAdvanceDays: row.maxAdvanceDays,
  };
}

/** Uma linha por empresa, criada sob demanda (`createMany` com `skipDuplicates`, sem `upsert`). */
export class PrismaScheduleSettingsRepository implements ScheduleSettingsRepository {
  constructor(private readonly prisma: TenantScopedPrisma) {}

  ensure(companyId: CompanyId): Promise<ScheduleSettings> {
    return withRepositoryErrors('ScheduleSettings.ensure', async () => {
      const existing = await this.prisma.scheduleSettings.findFirst({ where: { companyId } });
      if (existing !== null) return toSettings(existing);
      return runInTransaction(this.prisma, async (tx) => {
        // A linha e a "Agenda principal" nascem juntas: só quem inseriu a linha cria o recurso.
        const { count } = await tx.scheduleSettings.createMany({
          data: [{ companyId }],
          skipDuplicates: true,
        });
        if (count > 0) {
          await tx.scheduleResource.create({
            data: { companyId, name: SCHEDULE_MAIN_RESOURCE_NAME, position: 0 },
          });
        }
        const row = await tx.scheduleSettings.findFirst({ where: { companyId } });
        if (row === null) throw notFound('ScheduleSettings');
        return toSettings(row);
      });
    });
  }

  update(companyId: CompanyId, patch: ScheduleSettingsUpdate): Promise<ScheduleSettings> {
    return withRepositoryErrors('ScheduleSettings.update', async () => {
      await this.ensure(companyId);
      await this.prisma.scheduleSettings.updateMany({
        where: { companyId },
        data: {
          ...(patch.timezone === undefined ? {} : { timezone: patch.timezone }),
          ...(patch.slotStepMinutes === undefined
            ? {}
            : { slotStepMinutes: patch.slotStepMinutes }),
          ...(patch.minNoticeMinutes === undefined
            ? {}
            : { minNoticeMinutes: patch.minNoticeMinutes }),
          ...(patch.maxAdvanceDays === undefined ? {} : { maxAdvanceDays: patch.maxAdvanceDays }),
        },
      });
      const row = await this.prisma.scheduleSettings.findFirst({ where: { companyId } });
      if (row === null) throw notFound('ScheduleSettings');
      return toSettings(row);
    });
  }
}

/* ------------------------------------- recursos -------------------------------------- */

interface ResourceRow {
  readonly id: string;
  readonly companyId: string;
  readonly name: string;
  readonly active: boolean;
  readonly position: number;
}

function toResource(row: ResourceRow): ScheduleResource {
  return {
    id: row.id,
    companyId: CompanyIdFactory.parse(row.companyId),
    name: row.name,
    active: row.active,
    position: row.position,
  };
}

export class PrismaScheduleResourceRepository implements ScheduleResourceRepository {
  constructor(private readonly prisma: TenantScopedPrisma) {}

  list(companyId: CompanyId): Promise<ScheduleResource[]> {
    return withRepositoryErrors('ScheduleResource.list', async () => {
      const rows = await this.prisma.scheduleResource.findMany({
        where: { companyId },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        take: 100,
      });
      return rows.map(toResource);
    });
  }

  findById(companyId: CompanyId, resourceId: string): Promise<ScheduleResource> {
    return withRepositoryErrors('ScheduleResource.findById', async () => {
      if (!isUuid(resourceId)) throw notFound('ScheduleResource');
      const row = await this.prisma.scheduleResource.findFirst({
        where: { id: resourceId, companyId },
      });
      if (row === null) throw notFound('ScheduleResource');
      return toResource(row);
    });
  }

  create(
    companyId: CompanyId,
    data: { name: string; position: number },
  ): Promise<ScheduleResource> {
    return withRepositoryErrors('ScheduleResource.create', async () => {
      const row = await this.prisma.scheduleResource.create({
        data: { companyId, name: data.name, position: data.position },
      });
      return toResource(row);
    });
  }

  update(
    companyId: CompanyId,
    resourceId: string,
    patch: { name?: string; active?: boolean; position?: number },
  ): Promise<ScheduleResource> {
    return withRepositoryErrors('ScheduleResource.update', async () => {
      if (!isUuid(resourceId)) throw notFound('ScheduleResource');
      const { count } = await this.prisma.scheduleResource.updateMany({
        where: { id: resourceId, companyId },
        data: {
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.active === undefined ? {} : { active: patch.active }),
          ...(patch.position === undefined ? {} : { position: patch.position }),
        },
      });
      if (count === 0) throw notFound('ScheduleResource');
      const row = await this.prisma.scheduleResource.findFirst({
        where: { id: resourceId, companyId },
      });
      if (row === null) throw notFound('ScheduleResource');
      return toResource(row);
    });
  }
}

/* ------------------------------------- serviços -------------------------------------- */

interface ServiceRow {
  readonly id: string;
  readonly companyId: string;
  readonly name: string;
  readonly durationMinutes: number;
  readonly bufferMinutes: number;
  readonly active: boolean;
  readonly isSample: boolean;
}

function toService(row: ServiceRow): ScheduleServiceItem {
  return {
    id: row.id,
    companyId: CompanyIdFactory.parse(row.companyId),
    name: row.name,
    durationMinutes: row.durationMinutes,
    bufferMinutes: row.bufferMinutes,
    active: row.active,
    isSample: row.isSample,
  };
}

/** Serviços da empresa. **Sem delete**: agendamentos os referenciam; "remover" é `active: false`. */
export class PrismaScheduleServiceRepository implements ScheduleServiceRepository {
  constructor(private readonly prisma: TenantScopedPrisma) {}

  list(companyId: CompanyId): Promise<ScheduleServiceItem[]> {
    return withRepositoryErrors('ScheduleService.list', async () => {
      const rows = await this.prisma.scheduleService.findMany({
        where: { companyId },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: 200,
      });
      return rows.map(toService);
    });
  }

  findById(companyId: CompanyId, serviceId: string): Promise<ScheduleServiceItem> {
    return withRepositoryErrors('ScheduleService.findById', async () => {
      if (!isUuid(serviceId)) throw notFound('ScheduleService');
      const row = await this.prisma.scheduleService.findFirst({
        where: { id: serviceId, companyId },
      });
      if (row === null) throw notFound('ScheduleService');
      return toService(row);
    });
  }

  create(companyId: CompanyId, data: NewScheduleService): Promise<ScheduleServiceItem> {
    return withRepositoryErrors('ScheduleService.create', async () => {
      const row = await this.prisma.scheduleService.create({
        data: {
          companyId,
          name: data.name,
          durationMinutes: data.durationMinutes,
          bufferMinutes: data.bufferMinutes,
          isSample: data.isSample ?? false,
        },
      });
      return toService(row);
    });
  }

  update(
    companyId: CompanyId,
    serviceId: string,
    patch: ScheduleServiceUpdate,
  ): Promise<ScheduleServiceItem> {
    return withRepositoryErrors('ScheduleService.update', async () => {
      if (!isUuid(serviceId)) throw notFound('ScheduleService');
      const { count } = await this.prisma.scheduleService.updateMany({
        where: { id: serviceId, companyId },
        data: {
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.durationMinutes === undefined
            ? {}
            : { durationMinutes: patch.durationMinutes }),
          ...(patch.bufferMinutes === undefined ? {} : { bufferMinutes: patch.bufferMinutes }),
          ...(patch.active === undefined ? {} : { active: patch.active }),
        },
      });
      if (count === 0) throw notFound('ScheduleService');
      const row = await this.prisma.scheduleService.findFirst({
        where: { id: serviceId, companyId },
      });
      if (row === null) throw notFound('ScheduleService');
      return toService(row);
    });
  }

  listSamples(companyId: CompanyId): Promise<ScheduleServiceItem[]> {
    return withRepositoryErrors('ScheduleService.listSamples', async () => {
      const rows = await this.prisma.scheduleService.findMany({
        where: { companyId, isSample: true },
        orderBy: [{ name: 'asc' }],
        take: 20,
      });
      return rows.map(toService);
    });
  }
}

/* -------------------------------------- regras --------------------------------------- */

/**
 * Trava a linha do recurso (`FOR NO KEY UPDATE`: serializa dois `PUT` de regras sem bloquear o
 * `KEY SHARE` que o `INSERT` de um agendamento toma). SQL **controlado**: um único `SELECT`
 * parametrizado, com `company_id` na cláusula (cast para uuid; nada concatenado).
 */
async function lockResourceRow(
  db: TenantScopedDb,
  companyId: CompanyId,
  resourceId: string,
): Promise<void> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM schedule_resources
     WHERE id = ${resourceId}::uuid AND company_id = ${companyId}::uuid FOR NO KEY UPDATE`;
  if (rows.length === 0) throw notFound('ScheduleResource');
}

export class PrismaAvailabilityRuleRepository implements AvailabilityRuleRepository {
  constructor(private readonly prisma: TenantScopedPrisma) {}

  listForResources(
    companyId: CompanyId,
    resourceIds: readonly string[],
  ): Promise<AvailabilityRuleItem[]> {
    return withRepositoryErrors('AvailabilityRule.list', async () => {
      if (resourceIds.length === 0) return [];
      const rows = await this.prisma.availabilityRule.findMany({
        where: { companyId, resourceId: { in: [...resourceIds] } },
        orderBy: [{ resourceId: 'asc' }, { weekday: 'asc' }, { startMinute: 'asc' }],
        take: 1_000,
      });
      return rows.map((row) => ({
        resourceId: row.resourceId,
        weekday: row.weekday,
        startMinute: row.startMinute,
        endMinute: row.endMinute,
      }));
    });
  }

  replaceForResource(
    companyId: CompanyId,
    resourceId: string,
    windows: readonly AvailabilityWindow[],
  ): Promise<void> {
    return withRepositoryErrors('AvailabilityRule.replace', async () => {
      if (!isUuid(resourceId)) throw notFound('ScheduleResource');
      await runInTransaction(this.prisma, async (tx) => {
        await lockResourceRow(tx, companyId, resourceId);
        await tx.availabilityRule.deleteMany({ where: { companyId, resourceId } });
        if (windows.length > 0) {
          await tx.availabilityRule.createMany({
            data: windows.map((window) => ({
              companyId,
              resourceId,
              weekday: window.weekday,
              startMinute: window.startMinute,
              endMinute: window.endMinute,
            })),
          });
        }
      });
    });
  }
}

/* ---------------------------------- agendamentos ------------------------------------- */

interface AppointmentRow {
  readonly id: string;
  readonly companyId: string;
  readonly resourceId: string;
  readonly serviceId: string | null;
  readonly kind: AppointmentKind;
  readonly status: AppointmentStatus;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly blockedUntil: Date;
  readonly customerLabel: string | null;
  readonly contactRef: string | null;
  readonly source: 'PANEL' | 'CHANNEL';
  readonly createdByMembershipId: string | null;
  readonly cancelledAt: Date | null;
  readonly cancelledBy: 'PANEL' | 'CONTACT' | null;
  readonly createdAt: Date;
}

function toAppointment(row: AppointmentRow): Appointment {
  return {
    id: row.id,
    companyId: CompanyIdFactory.parse(row.companyId),
    resourceId: row.resourceId,
    serviceId: row.serviceId,
    kind: row.kind,
    status: row.status,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    blockedUntil: row.blockedUntil,
    customerLabel: row.customerLabel,
    contactRef: row.contactRef,
    source: row.source,
    createdByMembershipId: row.createdByMembershipId,
    cancelledAt: row.cancelledAt,
    cancelledBy: row.cancelledBy,
    createdAt: row.createdAt,
  };
}

const ACTIVE: AppointmentStatus[] = [...ACTIVE_APPOINTMENT_STATUSES];

function insertData(companyId: CompanyId, data: NewAppointment) {
  return {
    companyId,
    resourceId: data.resourceId,
    serviceId: data.serviceId,
    kind: data.kind,
    status: data.status,
    startsAt: data.startsAt,
    endsAt: data.endsAt,
    blockedUntil: data.blockedUntil,
    customerLabel: data.customerLabel,
    contactRef: data.contactRef,
    source: data.source,
    createdByMembershipId: data.createdByMembershipId,
  };
}

/**
 * Agendamentos e bloqueios da empresa. **A dupla reserva é impedida pelo banco** (restrição de
 * exclusão `appointments_no_overlap`): criar é um único `INSERT`, remarcar um único `UPDATE` da mesma
 * linha, e a violação (23P01) vira `SLOT_TAKEN` em `guardSlot`. `companyId` em todo `where`.
 */
export class PrismaAppointmentRepository implements AppointmentRepository {
  constructor(private readonly prisma: TenantScopedPrisma) {}

  list(companyId: CompanyId, filter: AppointmentFilter): Promise<Appointment[]> {
    return withRepositoryErrors('Appointment.list', async () => {
      const rows = await this.prisma.appointment.findMany({
        where: {
          companyId,
          startsAt: { gte: filter.from, lt: filter.to },
          ...(filter.resourceId === undefined ? {} : { resourceId: filter.resourceId }),
          ...(filter.serviceId === undefined ? {} : { serviceId: filter.serviceId }),
          ...(filter.status === undefined ? {} : { status: filter.status }),
        },
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        take: filter.limit,
      });
      return rows.map(toAppointment);
    });
  }

  findById(companyId: CompanyId, appointmentId: string): Promise<Appointment> {
    return withRepositoryErrors('Appointment.findById', async () => {
      if (!isUuid(appointmentId)) throw notFound('Appointment');
      const row = await this.prisma.appointment.findFirst({
        where: { id: appointmentId, companyId },
      });
      if (row === null) throw notFound('Appointment');
      return toAppointment(row);
    });
  }

  listBusy(
    companyId: CompanyId,
    resourceIds: readonly string[],
    from: Date,
    to: Date,
  ): Promise<BusyInterval[]> {
    return withRepositoryErrors('Appointment.listBusy', async () => {
      if (resourceIds.length === 0) return [];
      const rows = await this.prisma.appointment.findMany({
        where: {
          companyId,
          resourceId: { in: [...resourceIds] },
          status: { in: ACTIVE },
          startsAt: { lt: to },
          blockedUntil: { gt: from },
        },
        select: { resourceId: true, startsAt: true, blockedUntil: true },
        orderBy: [{ startsAt: 'asc' }],
        take: 5_000,
      });
      return rows;
    });
  }

  countActiveFuture(
    companyId: CompanyId,
    after: Date,
    options: { readonly resourceId?: string; readonly kind?: AppointmentKind } = {},
  ): Promise<number> {
    return withRepositoryErrors('Appointment.countActiveFuture', () =>
      this.prisma.appointment.count({
        where: {
          companyId,
          status: { in: ACTIVE },
          startsAt: { gt: after },
          ...(options.resourceId === undefined ? {} : { resourceId: options.resourceId }),
          ...(options.kind === undefined ? {} : { kind: options.kind }),
        },
      }),
    );
  }

  create(companyId: CompanyId, data: NewAppointment): Promise<Appointment> {
    return withRepositoryErrors('Appointment.create', () =>
      guardSlot(async () => {
        const row = await this.prisma.appointment.create({ data: insertData(companyId, data) });
        return toAppointment(row);
      }),
    );
  }

  createMany(companyId: CompanyId, data: readonly NewAppointment[]): Promise<Appointment[]> {
    return withRepositoryErrors('Appointment.createMany', () =>
      guardSlot(() =>
        runInTransaction(this.prisma, async (tx) => {
          const created: Appointment[] = [];
          for (const item of data) {
            try {
              created.push(
                toAppointment(await tx.appointment.create({ data: insertData(companyId, item) })),
              );
            } catch (error) {
              // O erro precisa sair da transação já traduzido: ela faz rollback de tudo.
              throw toSlotTaken(error);
            }
          }
          return created;
        }),
      ),
    );
  }

  transition(
    companyId: CompanyId,
    appointmentId: string,
    change: {
      readonly from: AppointmentStatus;
      readonly to: AppointmentStatus;
      readonly now: Date;
      readonly cancelledBy?: 'PANEL' | 'CONTACT';
    },
  ): Promise<Appointment | null> {
    return withRepositoryErrors('Appointment.transition', async () => {
      if (!isUuid(appointmentId)) throw notFound('Appointment');
      // O `status: from` no `where` decide a corrida: duas mudanças simultâneas, só uma acerta a linha.
      const { count } = await this.prisma.appointment.updateMany({
        where: { id: appointmentId, companyId, status: change.from },
        data: {
          status: change.to,
          ...(change.to === 'CANCELLED'
            ? { cancelledAt: change.now, cancelledBy: change.cancelledBy ?? 'PANEL' }
            : {}),
        },
      });
      if (count === 0) return null;
      return this.findById(companyId, appointmentId);
    });
  }

  reschedule(
    companyId: CompanyId,
    appointmentId: string,
    time: { readonly startsAt: Date; readonly endsAt: Date; readonly blockedUntil: Date },
  ): Promise<Appointment | null> {
    return withRepositoryErrors('Appointment.reschedule', () =>
      guardSlot(async () => {
        if (!isUuid(appointmentId)) throw notFound('Appointment');
        const count = await runInTransaction(this.prisma, async (tx) => {
          try {
            const result = await tx.appointment.updateMany({
              where: { id: appointmentId, companyId, status: { in: ACTIVE } },
              data: {
                startsAt: time.startsAt,
                endsAt: time.endsAt,
                blockedUntil: time.blockedUntil,
              },
            });
            return result.count;
          } catch (error) {
            throw toSlotTaken(error);
          }
        });
        if (count === 0) return null;
        return this.findById(companyId, appointmentId);
      }),
    );
  }

  updateCustomerLabel(
    companyId: CompanyId,
    appointmentId: string,
    customerLabel: string | null,
  ): Promise<Appointment> {
    return withRepositoryErrors('Appointment.updateCustomerLabel', async () => {
      if (!isUuid(appointmentId)) throw notFound('Appointment');
      const { count } = await this.prisma.appointment.updateMany({
        where: { id: appointmentId, companyId },
        data: { customerLabel },
      });
      if (count === 0) throw notFound('Appointment');
      return this.findById(companyId, appointmentId);
    });
  }
}
