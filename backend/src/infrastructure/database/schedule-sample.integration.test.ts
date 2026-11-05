import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  SAMPLE_WINDOWS,
  ScheduleSampleService,
} from '../../application/schedule/sample.service.js';
import { ScheduleService } from '../../application/schedule/schedule.service.js';
import { ConflictError } from '../../shared/errors/index.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import { createLogger } from '../logger/logger.js';
import { createDatabase, type Database } from './database.js';
import {
  PrismaAppointmentRepository,
  PrismaAvailabilityRuleRepository,
  PrismaScheduleResourceRepository,
  PrismaScheduleServiceRepository,
  PrismaScheduleSettingsRepository,
} from './repositories/schedule.repository.js';

const config = loadIntegrationConfig();
// Segunda-feira 2026-11-09, 08:00 em São Paulo.
const NOW = new Date('2026-11-09T11:00:00.000Z');

let database: Database;
let tenants: TestTenants;
let sample: ScheduleSampleService;
let schedule: ScheduleService;
const logs = captureLogs();

before(() => {
  database = createDatabase(config, createLogger(config));
  tenants = new TestTenants(database.prisma);
  const settings = new PrismaScheduleSettingsRepository(database.prisma);
  const resources = new PrismaScheduleResourceRepository(database.prisma);
  const services = new PrismaScheduleServiceRepository(database.prisma);
  const rules = new PrismaAvailabilityRuleRepository(database.prisma);
  sample = new ScheduleSampleService({ settings, resources, services, rules });
  schedule = new ScheduleService({
    settings,
    resources,
    services,
    rules,
    appointments: new PrismaAppointmentRepository(database.prisma),
    logger: logs.logger,
    now: () => NOW,
  });
});

after(async () => {
  try {
    await tenants.cleanup();
  } finally {
    await database.close();
  }
});

describe('exemplo da agenda (spec 027, E4)', () => {
  it('carrega o serviço e a semana útil; repetir não duplica; a agenda passa a oferecer horários', async () => {
    const company = await tenants.createCompany('smp-a');
    assert.deepEqual(await sample.load(company.id), { created: true });
    assert.deepEqual(await sample.load(company.id), { created: false });
    const listed = await schedule.listServices(company.id);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.name, 'Corte de cabelo');
    assert.equal(listed[0].isSample, true);
    const [main] = await schedule.listResources(company.id);
    assert.equal(main?.windows.length, SAMPLE_WINDOWS.length);
    const availability = await schedule.availability(company.id, {
      serviceId: listed[0].id,
      from: '2026-11-10',
      to: '2026-11-10',
    });
    assert.equal(availability.slots[0]?.localStart, '09:00');
    assert.equal(availability.slots.length, 18);
  });

  it('duas cargas simultâneas criam um só serviço', async () => {
    const company = await tenants.createCompany('smp-conc');
    const results = await Promise.all(Array.from({ length: 5 }, () => sample.load(company.id)));
    assert.equal(results.filter((result) => result.created).length, 1);
    assert.equal((await schedule.listServices(company.id)).length, 1);
  });

  it('só em agenda sem serviço seu: com serviço real recusa SAMPLE_REQUIRES_EMPTY e não toca em nada', async () => {
    const company = await tenants.createCompany('smp-real');
    await schedule.createService(company.id, {
      name: 'Consulta',
      durationMinutes: 60,
      bufferMinutes: 0,
    });
    await assert.rejects(
      sample.load(company.id),
      (error: unknown) => error instanceof ConflictError && error.code === 'SAMPLE_REQUIRES_EMPTY',
    );
    assert.equal((await schedule.listServices(company.id)).length, 1);
    const [main] = await schedule.listResources(company.id);
    assert.equal(main?.windows.length, 0);
  });

  it('remover desativa o serviço de exemplo e limpa as janelas do exemplo; carregar de novo reativa', async () => {
    const company = await tenants.createCompany('smp-rm');
    await sample.load(company.id);
    assert.deepEqual(await sample.remove(company.id), { services: 1 });
    assert.deepEqual(await sample.remove(company.id), { services: 0 });
    const [service] = await schedule.listServices(company.id);
    assert.equal(service?.active, false);
    const [main] = await schedule.listResources(company.id);
    assert.equal(main?.windows.length, 0);
    assert.deepEqual(await sample.load(company.id), { created: true });
    const [again] = await schedule.listServices(company.id);
    assert.equal(again?.active, true);
    assert.equal((await schedule.listServices(company.id)).length, 1);
  });

  it('janelas editadas pela empresa não são apagadas ao remover o exemplo; outra empresa não é afetada', async () => {
    const company = await tenants.createCompany('smp-edit');
    const other = await tenants.createCompany('smp-other');
    await sample.load(company.id);
    await sample.load(other.id);
    const [main] = await schedule.listResources(company.id);
    assert.ok(main !== undefined);
    await schedule.setRules(company.id, main.id, [{ weekday: 6, start: 600, end: 720 }]);
    await sample.remove(company.id);
    const [kept] = await schedule.listResources(company.id);
    assert.equal(kept?.windows.length, 1);
    // A outra empresa continua com o exemplo ativo.
    const [otherService] = await schedule.listServices(other.id);
    assert.equal(otherService?.active, true);
  });
});
