import {
  type AvailabilityRuleRepository,
  type AvailabilityWindow,
  type CompanyId,
  type ScheduleResourceRepository,
  type ScheduleServiceRepository,
  type ScheduleSettingsRepository,
} from '../../domain/index.js';
import { ConflictError } from '../../shared/errors/index.js';

export const SCHEDULE_SAMPLE_REQUIRES_EMPTY = 'SAMPLE_REQUIRES_EMPTY';

/** O exemplo da agenda (spec 027, E4): um serviço e a semana útil, das 9h às 18h. */
export const SAMPLE_SERVICE = {
  name: 'Corte de cabelo',
  durationMinutes: 30,
  bufferMinutes: 0,
} as const;
export const SAMPLE_WINDOWS: readonly AvailabilityWindow[] = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  startMinute: 9 * 60,
  endMinute: 18 * 60,
}));

export interface ScheduleSampleDeps {
  readonly settings: ScheduleSettingsRepository;
  readonly resources: ScheduleResourceRepository;
  readonly services: ScheduleServiceRepository;
  readonly rules: AvailabilityRuleRepository;
}

const sameWindows = (
  found: readonly AvailabilityWindow[],
  expected: readonly AvailabilityWindow[],
): boolean =>
  found.length === expected.length &&
  expected.every((window) =>
    found.some(
      (item) =>
        item.weekday === window.weekday &&
        item.startMinute === window.startMinute &&
        item.endMinute === window.endMinute,
    ),
  );

/**
 * Exemplo da agenda ("Carregar exemplo"): só em empresa sem agenda (serviço que não seja de exemplo
 * recusa com `SAMPLE_REQUIRES_EMPTY`), idempotente e removível (o serviço de exemplo é **desativado**:
 * serviço não é apagado; e as janelas da "Agenda principal" só são limpas se ainda forem exatamente as
 * do exemplo). O `CompanyId` vem da identidade; nada do conteúdo é logado.
 */
export class ScheduleSampleService {
  /** Cauda de execução por empresa: duas cargas simultâneas da mesma empresa rodam uma depois da outra. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: ScheduleSampleDeps) {}

  load(companyId: CompanyId): Promise<{ readonly created: boolean }> {
    const previous = this.queues.get(companyId) ?? Promise.resolve();
    const run = previous.then(
      () => this.loadNow(companyId),
      () => this.loadNow(companyId),
    );
    const tail = run.catch(() => undefined);
    this.queues.set(companyId, tail);
    void tail.then(() => {
      if (this.queues.get(companyId) === tail) this.queues.delete(companyId);
    });
    return run;
  }

  private async loadNow(companyId: CompanyId): Promise<{ readonly created: boolean }> {
    const { settings, resources, services, rules } = this.deps;
    await settings.ensure(companyId); // cria a "Agenda principal" na primeira vez
    const current = await services.list(companyId);
    if (current.some((service) => !service.isSample)) {
      throw new ConflictError('O exemplo só carrega em empresa sem agenda', {
        code: SCHEDULE_SAMPLE_REQUIRES_EMPTY,
      });
    }
    let created = false;
    const existing = current.find((service) => service.isSample);
    if (existing === undefined) {
      await services.create(companyId, { ...SAMPLE_SERVICE, isSample: true });
      created = true;
    } else if (!existing.active) {
      await services.update(companyId, existing.id, { active: true });
      created = true;
    }
    const [main] = await resources.list(companyId);
    if (main !== undefined) {
      const windows = await rules.listForResources(companyId, [main.id]);
      if (windows.length === 0) {
        await rules.replaceForResource(companyId, main.id, SAMPLE_WINDOWS);
        created = true;
      }
    }
    return { created };
  }

  /** Desativa o serviço de exemplo e limpa as janelas do exemplo. Devolve quantos serviços desativou. */
  async remove(companyId: CompanyId): Promise<{ readonly services: number }> {
    const { resources, services, rules } = this.deps;
    let deactivated = 0;
    const current = await services.list(companyId);
    for (const service of current) {
      if (service.isSample && service.active) {
        await services.update(companyId, service.id, { active: false });
        deactivated += 1;
      }
    }
    const onlySamples = current.every((service) => service.isSample);
    const [main] = await resources.list(companyId);
    if (onlySamples && main !== undefined) {
      const windows = await rules.listForResources(companyId, [main.id]);
      if (sameWindows(windows, SAMPLE_WINDOWS)) {
        await rules.replaceForResource(companyId, main.id, []);
      }
    }
    return { services: deactivated };
  }
}
