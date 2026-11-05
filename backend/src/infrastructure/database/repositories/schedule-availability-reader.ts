import type {
  AvailableSlot,
  ScheduleAvailability,
  ScheduleAvailabilityReader,
  ServiceAvailability,
} from '../../../application/ports/schedule-availability-reader.js';
import { computeSlots, type Slot } from '../../../application/schedule/availability.js';
import { addDays, localPartsOf, zonedToInstant } from '../../../application/schedule/zoned-time.js';
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
} from '../../../domain/index.js';
import type { TenantScopedPrisma } from '../extensions/tenant-scope.js';
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
  ) {}

  read(companyId: CompanyId): Promise<ScheduleAvailability> {
    return withRepositoryErrors('ScheduleAvailability.read', async () => {
      const now = this.now();
      const settings = await this.prisma.scheduleSettings.findFirst({ where: { companyId } });
      const timezone = settings?.timezone ?? SCHEDULE_DEFAULT_TIMEZONE;
      const today = localPartsOf(now, timezone).date;
      const empty: ScheduleAvailability = {
        timezone,
        generatedAt: now,
        today,
        services: [],
        hasSchedule: false,
      };
      const services = await this.prisma.scheduleService.findMany({
        where: { companyId, active: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: MAX_SERVICES_READ,
      });
      if (services.length === 0) return empty;

      const resources = await this.prisma.scheduleResource.findMany({
        where: { companyId, active: true },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        take: SCHEDULE_MAX_RESOURCES,
      });
      const ids = resources.map((resource) => resource.id);
      const rules =
        ids.length === 0
          ? []
          : await this.prisma.availabilityRule.findMany({
              where: { companyId, resourceId: { in: ids } },
              take: 1_000,
            });
      const toDate = addDays(today, SCHEDULE_PROMPT_WINDOW_DAYS - 1);
      const base = (
        zonedToInstant(today, 0, timezone) ??
        zonedToInstant(today, 60, timezone) ??
        now
      ).getTime();
      const busy =
        ids.length === 0
          ? []
          : await this.prisma.appointment.findMany({
              where: {
                companyId,
                resourceId: { in: ids },
                status: { in: ACTIVE },
                startsAt: { lt: new Date(base + (SCHEDULE_PROMPT_WINDOW_DAYS + 2) * DAY_MS) },
                blockedUntil: { gt: new Date(base - DAY_MS) },
              },
              select: { resourceId: true, startsAt: true, blockedUntil: true },
              take: 5_000,
            });

      const computed = services.map((service) => {
        const slots = computeSlots({
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
          fromDate: today,
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
    });
  }
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
