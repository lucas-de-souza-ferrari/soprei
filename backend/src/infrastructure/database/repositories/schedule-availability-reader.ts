import type {
  AvailableSlot,
  ContactAppointmentView,
  ScheduleAvailability,
  ScheduleAvailabilityReader,
  ServiceAvailability,
} from '../../../application/ports/schedule-availability-reader.js';
import { computeSlots, type Slot } from '../../../application/schedule/availability.js';
import {
  addDays,
  daysBetween,
  formatLocalTime,
  localPartsOf,
  zonedToInstant,
} from '../../../application/schedule/zoned-time.js';
import {
  ACTIVE_APPOINTMENT_STATUSES,
  type AppointmentStatus,
  type CompanyId,
  SCHEDULE_DEFAULT_MAX_ADVANCE_DAYS,
  SCHEDULE_DEFAULT_MIN_NOTICE_MINUTES,
  SCHEDULE_DEFAULT_SLOT_STEP_MINUTES,
  SCHEDULE_DEFAULT_TIMEZONE,
  SCHEDULE_MAX_RESOURCES,
  SCHEDULE_PROMPT_WINDOW_DAYS,
  SCHEDULE_RETRIEVAL_TIMEOUT_MS,
} from '../../../domain/index.js';
import type { TenantScopedDb, TenantScopedPrisma } from '../extensions/tenant-scope.js';
import { withStatementTimeout } from './knowledge-retriever.js';
import { withRepositoryErrors } from './repository-errors.js';

const DAY_MS = 86_400_000;
/** Serviços ativos considerados por leitura (o prompt mostra só os 5 mais próximos no tempo). */
const MAX_SERVICES_READ = 20;
const ACTIVE: AppointmentStatus[] = [...ACTIVE_APPOINTMENT_STATUSES];

/**
 * Horários livres da empresa para o prompt da IA (spec 027, E3). **Só leitura** (nada é criado: nem as
 * configurações padrão) e **sempre** com `companyId` no `where`. Usa o mesmo `computeSlots` da API, com o
 * mesmo relógio injetável; a janela é de `SCHEDULE_PROMPT_WINDOW_DAYS` dias a partir de hoje no fuso da
 * empresa. Nome de serviço e horários nunca vão a log (o chamador só registra ids e contagens).
 */
export class PrismaScheduleAvailabilityReader implements ScheduleAvailabilityReader {
  constructor(
    private readonly prisma: TenantScopedPrisma,
    private readonly now: () => Date = () => new Date(),
    private readonly statementTimeoutMs: number = SCHEDULE_RETRIEVAL_TIMEOUT_MS,
  ) {}

  read(
    companyId: CompanyId,
    range?: { readonly fromDate?: string; readonly toDate?: string },
  ): Promise<ScheduleAvailability> {
    return withRepositoryErrors('ScheduleAvailability.read', () =>
      // Transação curta com `statement_timeout` local: estourado o prazo, o banco cancela a consulta.
      withStatementTimeout(this.prisma, this.statementTimeoutMs, (db) =>
        this.readIn(db, companyId, range),
      ),
    );
  }

  /** Só leitura, sempre com `companyId` **e** `contactRef` no `where` (spec 028). */
  readContactAppointments(
    companyId: CompanyId,
    contactRef: string,
    limit: number,
  ): Promise<readonly ContactAppointmentView[]> {
    return withRepositoryErrors('ScheduleAvailability.readContactAppointments', () =>
      withStatementTimeout(this.prisma, this.statementTimeoutMs, async (db) => {
        const now = this.now();
        const settings = await db.scheduleSettings.findFirst({ where: { companyId } });
        const timezone = settings?.timezone ?? SCHEDULE_DEFAULT_TIMEZONE;
        const rows = await db.appointment.findMany({
          where: {
            companyId,
            contactRef,
            kind: 'BOOKING',
            status: { in: ACTIVE },
            startsAt: { gte: now },
          },
          orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
          take: limit,
          select: { id: true, serviceId: true, startsAt: true, status: true },
        });
        const serviceIds = [
          ...new Set(rows.flatMap((row) => (row.serviceId === null ? [] : [row.serviceId]))),
        ];
        const services =
          serviceIds.length === 0
            ? []
            : await db.scheduleService.findMany({
                where: { companyId, id: { in: serviceIds } },
                select: { id: true, name: true },
              });
        const names = new Map(services.map((service) => [service.id, service.name] as const));
        return rows.flatMap((row): ContactAppointmentView[] => {
          if (row.status !== 'PENDING' && row.status !== 'CONFIRMED') return [];
          return [
            {
              id: row.id,
              serviceName: row.serviceId === null ? '' : (names.get(row.serviceId) ?? ''),
              localDate: localPartsOf(row.startsAt, timezone).date,
              localStart: formatLocalTime(row.startsAt, timezone),
              status: row.status,
            },
          ];
        });
      }),
    );
  }

  private async readIn(
    db: TenantScopedDb,
    companyId: CompanyId,
    range?: { readonly fromDate?: string; readonly toDate?: string },
  ): Promise<ScheduleAvailability> {
    {
      const now = this.now();
      const settings = await db.scheduleSettings.findFirst({ where: { companyId } });
      const timezone = settings?.timezone ?? SCHEDULE_DEFAULT_TIMEZONE;
      const today = localPartsOf(now, timezone).date;
      const empty: ScheduleAvailability = {
        timezone,
        generatedAt: now,
        today,
        services: [],
        hasSchedule: false,
        ai: {
          bookingEnabled: settings?.aiBookingEnabled ?? false,
          autoConfirm: settings?.aiAutoConfirm ?? false,
        },
      };
      const services = await db.scheduleService.findMany({
        where: { companyId, active: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: MAX_SERVICES_READ,
      });
      if (services.length === 0) return empty;

      const resources = await db.scheduleResource.findMany({
        where: { companyId, active: true },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        take: SCHEDULE_MAX_RESOURCES,
      });
      const ids = resources.map((resource) => resource.id);
      const rules =
        ids.length === 0
          ? []
          : await db.availabilityRule.findMany({
              where: { companyId, resourceId: { in: ids } },
              take: 1_000,
            });
      // Nunca antes de hoje; no máximo `SCHEDULE_PROMPT_WINDOW_DAYS` dias a partir do início.
      const requestedFrom = range?.fromDate;
      const fromDate = requestedFrom === undefined || requestedFrom < today ? today : requestedFrom;
      const lastAllowed = addDays(fromDate, SCHEDULE_PROMPT_WINDOW_DAYS - 1);
      const toDate = range?.toDate === undefined ? lastAllowed : minDate(range.toDate, lastAllowed);
      const spanDays = toDate < fromDate ? 0 : daysBetween(fromDate, toDate) + 1;
      const base = (
        zonedToInstant(fromDate, 0, timezone) ??
        zonedToInstant(fromDate, 60, timezone) ??
        now
      ).getTime();
      const busy =
        ids.length === 0
          ? []
          : await db.appointment.findMany({
              where: {
                companyId,
                resourceId: { in: ids },
                status: { in: ACTIVE },
                startsAt: { lt: new Date(base + (spanDays + 2) * DAY_MS) },
                blockedUntil: { gt: new Date(base - DAY_MS) },
              },
              select: { resourceId: true, startsAt: true, blockedUntil: true },
              take: 5_000,
            });

      const computed = services.map((service) => {
        const slots =
          spanDays === 0
            ? []
            : computeSlots({
                timezone,
                slotStepMinutes: settings?.slotStepMinutes ?? SCHEDULE_DEFAULT_SLOT_STEP_MINUTES,
                minNoticeMinutes: settings?.minNoticeMinutes ?? SCHEDULE_DEFAULT_MIN_NOTICE_MINUTES,
                maxAdvanceDays: settings?.maxAdvanceDays ?? SCHEDULE_DEFAULT_MAX_ADVANCE_DAYS,
                service,
                resources: resources.map((resource) => ({
                  id: resource.id,
                  windows: rules.filter((rule) => rule.resourceId === resource.id),
                })),
                busy,
                now,
                fromDate,
                toDate,
              });
        return { service, slots };
      });
      // Os serviços com horário mais próximo primeiro; sem horário, por último (e por nome).
      computed.sort(
        (left, right) =>
          (left.slots[0]?.startsAt.getTime() ?? Number.POSITIVE_INFINITY) -
            (right.slots[0]?.startsAt.getTime() ?? Number.POSITIVE_INFINITY) ||
          left.service.name.localeCompare(right.service.name),
      );
      return {
        ...empty,
        hasSchedule: true,
        services: computed.map(({ service, slots }): ServiceAvailability => ({
          name: service.name,
          durationMinutes: service.durationMinutes,
          slots: distinctSlots(slots),
        })),
      };
    }
  }
}

function minDate(left: string, right: string): string {
  return left < right ? left : right;
}

/** Vários recursos livres no mesmo horário contam uma vez só. */
function distinctSlots(slots: readonly Slot[]): AvailableSlot[] {
  const seen = new Set<string>();
  const result: AvailableSlot[] = [];
  for (const slot of slots) {
    const key = `${slot.localDate} ${slot.localStart}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ localDate: slot.localDate, localStart: slot.localStart });
  }
  return result;
}
