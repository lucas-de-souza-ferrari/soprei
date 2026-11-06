import type {
  ContactScheduleConfig,
  ContactScheduleTransaction,
  ContactScheduleUnitOfWork,
} from '../../../application/ports/contact-scheduling.js';
import {
  ACTIVE_APPOINTMENT_STATUSES,
  type Appointment,
  type AppointmentStatus,
  type BusyInterval,
  type CompanyId,
  CompanyId as CompanyIdFactory,
  type NewAppointment,
  SCHEDULE_AI_TOOL_WRITE_TIMEOUT_MS,
  SCHEDULE_DEFAULT_MAX_ADVANCE_DAYS,
  SCHEDULE_DEFAULT_MIN_NOTICE_MINUTES,
  SCHEDULE_DEFAULT_SLOT_STEP_MINUTES,
  SCHEDULE_DEFAULT_TIMEZONE,
  SCHEDULE_MAX_RESOURCES,
} from '../../../domain/index.js';
import { isUuid } from '../../../shared/utils/index.js';
import type { TenantScopedDb, TenantScopedPrisma } from '../extensions/tenant-scope.js';
import { runInTransaction } from '../transaction.js';
import { toSlotTaken } from './schedule.repository.js';

const ACTIVE: AppointmentStatus[] = [...ACTIVE_APPOINTMENT_STATUSES];

/**
 * Trava a linha da empresa até o fim da transação (`FOR NO KEY UPDATE`, o mesmo bloqueio da gestão de
 * membros e dos convites: serializa as escritas da IA da empresa sem bloquear o `KEY SHARE` que o `INSERT`
 * de um agendamento toma). SQL **controlado**: um `SELECT` parametrizado, com `id` cast para uuid.
 */
async function lockCompanyRow(db: TenantScopedDb, companyId: CompanyId): Promise<boolean> {
  const rows = await db.$queryRaw<{ status: string }[]>`
    SELECT status::text AS status FROM companies
    WHERE id = ${companyId}::uuid AND deleted_at IS NULL FOR NO KEY UPDATE`;
  const row = rows[0];
  return row !== undefined && row.status === 'ACTIVE';
}

interface AppointmentRow {
  readonly id: string;
  readonly companyId: string;
  readonly resourceId: string;
  readonly serviceId: string | null;
  readonly kind: 'BOOKING' | 'BLOCK';
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
  return { ...row, companyId: CompanyIdFactory.parse(row.companyId) };
}

/**
 * Transação das escritas da IA na agenda (spec 028). **Todo** `where` leva `companyId` e, nas consultas de
 * contato, `contactRef`. A dupla reserva é impedida pela restrição de exclusão do banco: a violação
 * (23P01) sai daqui já traduzida para `SLOT_TAKEN` por `toSlotTaken` (o ponto único da 027).
 */
class PrismaContactScheduleTransaction implements ContactScheduleTransaction {
  constructor(private readonly db: TenantScopedDb) {}

  async lockCompany(companyId: CompanyId): Promise<{ readonly active: boolean }> {
    return { active: await lockCompanyRow(this.db, companyId) };
  }

  async loadConfig(companyId: CompanyId): Promise<ContactScheduleConfig> {
    const settings = await this.db.scheduleSettings.findFirst({ where: { companyId } });
    const resources = await this.db.scheduleResource.findMany({
      where: { companyId, active: true },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      take: SCHEDULE_MAX_RESOURCES,
    });
    const ids = resources.map((resource) => resource.id);
    const rules =
      ids.length === 0
        ? []
        : await this.db.availabilityRule.findMany({
            where: { companyId, resourceId: { in: ids } },
            take: 1_000,
          });
    const services = await this.db.scheduleService.findMany({
      where: { companyId },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: 200,
    });
    return {
      aiBookingEnabled: settings?.aiBookingEnabled ?? false,
      aiAutoConfirm: settings?.aiAutoConfirm ?? false,
      timezone: settings?.timezone ?? SCHEDULE_DEFAULT_TIMEZONE,
      slotStepMinutes: settings?.slotStepMinutes ?? SCHEDULE_DEFAULT_SLOT_STEP_MINUTES,
      minNoticeMinutes: settings?.minNoticeMinutes ?? SCHEDULE_DEFAULT_MIN_NOTICE_MINUTES,
      maxAdvanceDays: settings?.maxAdvanceDays ?? SCHEDULE_DEFAULT_MAX_ADVANCE_DAYS,
      resources: resources.map((resource) => ({
        id: resource.id,
        windows: rules
          .filter((rule) => rule.resourceId === resource.id)
          .map((rule) => ({
            weekday: rule.weekday,
            startMinute: rule.startMinute,
            endMinute: rule.endMinute,
          })),
      })),
      services: services.map((service) => ({
        id: service.id,
        companyId,
        name: service.name,
        durationMinutes: service.durationMinutes,
        bufferMinutes: service.bufferMinutes,
        active: service.active,
        isSample: service.isSample,
      })),
    };
  }

  async listBusy(
    companyId: CompanyId,
    resourceIds: readonly string[],
    from: Date,
    to: Date,
  ): Promise<BusyInterval[]> {
    if (resourceIds.length === 0) return [];
    return this.db.appointment.findMany({
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
  }

  async findActiveSame(
    companyId: CompanyId,
    contactRef: string,
    serviceId: string,
    startsAt: Date,
  ): Promise<Appointment | null> {
    const row = await this.db.appointment.findFirst({
      where: {
        companyId,
        contactRef,
        serviceId,
        startsAt,
        kind: 'BOOKING',
        status: { in: ACTIVE },
      },
    });
    return row === null ? null : toAppointment(row);
  }

  async findForContact(
    companyId: CompanyId,
    contactRef: string,
    appointmentId: string,
  ): Promise<Appointment | null> {
    if (!isUuid(appointmentId)) return null;
    const row = await this.db.appointment.findFirst({
      where: { id: appointmentId, companyId, contactRef },
    });
    return row === null ? null : toAppointment(row);
  }

  countActiveFutureByContact(
    companyId: CompanyId,
    contactRef: string,
    after: Date,
  ): Promise<number> {
    return this.db.appointment.count({
      where: {
        companyId,
        contactRef,
        kind: 'BOOKING',
        status: { in: ACTIVE },
        startsAt: { gte: after },
      },
    });
  }

  countCreatedByContactSince(
    companyId: CompanyId,
    contactRef: string,
    since: Date,
  ): Promise<number> {
    return this.db.appointment.count({
      where: { companyId, contactRef, kind: 'BOOKING', createdAt: { gte: since } },
    });
  }

  countActiveChannelFuture(companyId: CompanyId, after: Date): Promise<number> {
    return this.db.appointment.count({
      where: {
        companyId,
        kind: 'BOOKING',
        source: 'CHANNEL',
        status: { in: ACTIVE },
        startsAt: { gte: after },
      },
    });
  }

  countPendingChannelFuture(companyId: CompanyId, after: Date): Promise<number> {
    return this.db.appointment.count({
      where: {
        companyId,
        kind: 'BOOKING',
        source: 'CHANNEL',
        status: 'PENDING',
        startsAt: { gte: after },
      },
    });
  }

  async cancelForContact(
    companyId: CompanyId,
    contactRef: string,
    appointmentId: string,
    now: Date,
  ): Promise<Appointment | null> {
    if (!isUuid(appointmentId)) return null;
    // `company_id`, `contact_ref`, `kind` e o estado ativo no `where`: só a reserva do próprio contato.
    const { count } = await this.db.appointment.updateMany({
      where: { id: appointmentId, companyId, contactRef, kind: 'BOOKING', status: { in: ACTIVE } },
      data: { status: 'CANCELLED', cancelledAt: now, cancelledBy: 'CONTACT' },
    });
    if (count === 0) return null;
    return this.findForContact(companyId, contactRef, appointmentId);
  }

  async create(companyId: CompanyId, data: NewAppointment): Promise<Appointment> {
    try {
      const row = await this.db.appointment.create({
        data: {
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
        },
      });
      return toAppointment(row);
    } catch (error) {
      // O erro precisa sair da transação já traduzido: ela faz rollback de tudo.
      throw toSlotTaken(error);
    }
  }
}

/**
 * Unidade de trabalho das escritas da IA: transação com `statement_timeout` de 3 s (cancela **no banco**; o
 * servidor nunca abandona uma escrita no meio por prazo de aplicação). Uma tentativa extra só para erro
 * recuperável (deadlock, serialização).
 */
export class PrismaContactScheduleUnitOfWork implements ContactScheduleUnitOfWork {
  constructor(
    private readonly prisma: TenantScopedPrisma,
    private readonly statementTimeoutMs: number = SCHEDULE_AI_TOOL_WRITE_TIMEOUT_MS,
  ) {}

  run<T>(fn: (tx: ContactScheduleTransaction) => Promise<T>): Promise<T> {
    return runInTransaction(
      this.prisma,
      async (db) => {
        await db.$executeRaw`SELECT set_config('statement_timeout', ${String(this.statementTimeoutMs)}, true)`;
        return fn(new PrismaContactScheduleTransaction(db));
      },
      { maxRetries: 1 },
    );
  }
}
