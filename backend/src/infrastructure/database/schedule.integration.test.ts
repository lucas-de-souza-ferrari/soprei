import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { ScheduleService } from '../../application/schedule/schedule.service.js';
import {
  type Appointment,
  type AppointmentRepository,
  type Company,
  type Membership,
  SCHEDULE_MAX_ACTIVE_FUTURE,
  SCHEDULE_MAX_RESOURCES,
} from '../../domain/index.js';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors/index.js';
import { captureLogs, logContains } from '../../test-support/log-capture.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import { createLogger } from '../logger/logger.js';
import { createMetrics } from '../metrics/index.js';
import { createDatabase, type Database } from './database.js';
import { PrismaMembershipRepository } from './repositories/membership.repository.js';
import {
  PrismaAppointmentRepository,
  PrismaAvailabilityRuleRepository,
  PrismaScheduleResourceRepository,
  PrismaScheduleServiceRepository,
  PrismaScheduleSettingsRepository,
} from './repositories/schedule.repository.js';

const config = loadIntegrationConfig();
const HASH = 'scrypt$1024$8$1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA==';
// Segunda-feira 2026-11-09, 08:00 em São Paulo. Os agendamentos dos testes ficam em dezembro de 2026.
const NOW = new Date('2026-11-09T11:00:00.000Z');
const SECRET_SERVICE = `Servico secreto ${randomBytes(6).toString('hex')}`;
const SECRET_LABEL = `Pessoa secreta ${randomBytes(6).toString('hex')}`;
const SECRET_CONTACT = `5511${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;

let database: Database;
let tenants: TestTenants;
let schedule: ScheduleService;
let appointments: PrismaAppointmentRepository;
let resources: PrismaScheduleResourceRepository;
let sql: pg.Client;
let memberships: PrismaMembershipRepository;
const logs = captureLogs();
const metrics = createMetrics();
let clock = NOW;

const email = (label: string): string => `${label}-${randomBytes(5).toString('hex')}@exemplo.test`;

before(async () => {
  // Pool maior que as 20 reservas simultâneas do teste de concorrência: com o pool padrão (10) e o prazo de 5 s, uma CI lenta
  // faria algumas esperarem conexão e falharem por prazo, não por SLOT_TAKEN.
  database = createDatabase(
    { ...config, DB_POOL_MAX: 30, DB_POOL_CONNECTION_TIMEOUT_MS: 30_000 },
    createLogger(config),
  );
  tenants = new TestTenants(database.prisma);
  appointments = new PrismaAppointmentRepository(database.prisma);
  resources = new PrismaScheduleResourceRepository(database.prisma);
  schedule = buildService(appointments);
  memberships = new PrismaMembershipRepository(database.prisma);
  sql = new pg.Client({ connectionString: config.DATABASE_URL });
  await sql.connect();
});

after(async () => {
  try {
    await sql.end();
    await tenants.cleanup();
  } finally {
    await database.close();
  }
});

function buildService(repo: AppointmentRepository): ScheduleService {
  return new ScheduleService({
    settings: new PrismaScheduleSettingsRepository(database.prisma),
    resources,
    services: new PrismaScheduleServiceRepository(database.prisma),
    rules: new PrismaAvailabilityRuleRepository(database.prisma),
    appointments: repo,
    logger: logs.logger,
    metrics,
    now: () => clock,
  });
}

interface World {
  readonly company: Company;
  readonly owner: Membership;
  readonly resourceId: string;
  readonly serviceId: string;
}

/** Empresa com dono, a "Agenda principal" e um serviço (30 min, sem intervalo por padrão). */
async function world(
  label: string,
  service: { durationMinutes?: number; bufferMinutes?: number; name?: string } = {},
): Promise<World> {
  const company = await tenants.createCompany(label);
  const owner = await memberships.create(company.id, {
    email: email(label),
    passwordHash: HASH,
    role: 'OWNER',
  });
  const [main] = await schedule.listResources(company.id);
  assert.ok(main !== undefined, 'a Agenda principal nasce com as configurações');
  const created = await schedule.createService(company.id, {
    name: service.name ?? 'Corte de cabelo',
    durationMinutes: service.durationMinutes ?? 30,
    bufferMinutes: service.bufferMinutes ?? 0,
  });
  return { company, owner, resourceId: main.id, serviceId: created.id };
}

const book = (
  w: World,
  localStart: string,
  extra: { resourceId?: string; serviceId?: string } = {},
) =>
  schedule.createAppointment(w.company.id, w.owner.id, {
    serviceId: extra.serviceId ?? w.serviceId,
    resourceId: extra.resourceId ?? w.resourceId,
    localStart,
  });

const isSlotTaken = (reason: unknown): boolean =>
  reason instanceof ConflictError && reason.code === 'SLOT_TAKEN';

const activeCount = async (resourceId: string): Promise<number> =>
  Number(
    (
      await sql.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM appointments WHERE resource_id = $1 AND status IN ('PENDING','CONFIRMED')`,
        [resourceId],
      )
    ).rows[0]?.count,
  );

describe('dupla reserva: a restrição do banco (spec 027, E1)', () => {
  it('20 criações simultâneas do mesmo recurso e horário: 1 sucesso, 19 SLOT_TAKEN, 1 linha ativa', async () => {
    const w = await world('conc-a');
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => book(w, '2026-12-01T10:00')),
    );
    const ok = results.filter((result) => result.status === 'fulfilled');
    const refused = results.filter((result) => result.status === 'rejected');
    assert.equal(ok.length, 1);
    assert.equal(refused.length, 19);
    for (const result of refused) {
      assert.ok(
        isSlotTaken(result.reason),
        `recusa inesperada: ${result.reason instanceof Error ? `${result.reason.name} ${result.reason.message.slice(0, 200)}` : String(result.reason)}`,
      );
    }
    assert.equal(await activeCount(w.resourceId), 1);
    const total = await sql.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM appointments WHERE resource_id = $1',
      [w.resourceId],
    );
    assert.equal(total.rows[0]?.count, '1');
  });

  it('sobreposição parcial simultânea (10:00-10:30 contra 10:15-10:45): um ganha; adjacentes passam', async () => {
    const w = await world('conc-b');
    for (const day of ['02', '03', '04']) {
      const results = await Promise.allSettled([
        book(w, `2026-12-${day}T10:00`),
        book(w, `2026-12-${day}T10:15`),
      ]);
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    }
    // Adjacentes (10:00-10:30 e 10:30-11:00): ambos passam, também ao mesmo tempo.
    const adjacent = await Promise.allSettled([
      book(w, '2026-12-07T10:00'),
      book(w, '2026-12-07T10:30'),
    ]);
    assert.equal(adjacent.filter((result) => result.status === 'fulfilled').length, 2);
  });

  it('intervalo do serviço: com 10 min, 10:30 colide e 10:40 passa (limite semiaberto)', async () => {
    const w = await world('buf', { bufferMinutes: 10 });
    await book(w, '2026-12-01T10:00'); // ocupa até 10:40
    await assert.rejects(book(w, '2026-12-01T10:30'), isSlotTaken);
    await book(w, '2026-12-01T10:40');
    assert.equal(await activeCount(w.resourceId), 2);
  });

  it('recursos diferentes e empresas diferentes são independentes', async () => {
    const a = await world('ind-a');
    const b = await world('ind-b');
    const second = await schedule.createResource(a.company.id, { name: 'Sala 2' });
    await book(a, '2026-12-01T10:00');
    await book(a, '2026-12-01T10:00', { resourceId: second.id });
    await book(b, '2026-12-01T10:00');
    assert.equal(await activeCount(a.resourceId), 1);
    assert.equal(await activeCount(second.id), 1);
    assert.equal(await activeCount(b.resourceId), 1);
  });

  it('cancelar libera o horário; cancelamento duplicado e simultâneo é idempotente', async () => {
    const w = await world('cancel');
    const first = await book(w, '2026-12-01T10:00');
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        schedule.updateAppointment(w.company.id, w.owner.id, first.id, { status: 'CANCELLED' }),
      ),
    );
    assert.ok(results.every((row) => row.status === 'CANCELLED'));
    assert.equal(new Set(results.map((row) => row.cancelledAt?.getTime())).size, 1);
    const stored = await sql.query<{ cancelled_at: Date | null; cancelled_by: string | null }>(
      'SELECT cancelled_at, cancelled_by FROM appointments WHERE id = $1',
      [first.id],
    );
    assert.ok(stored.rows[0]?.cancelled_at instanceof Date);
    assert.equal(stored.rows[0].cancelled_by, 'PANEL');
    // O mesmo horário volta a ser reservável.
    await book(w, '2026-12-01T10:00');
    assert.equal(await activeCount(w.resourceId), 1);
  });

  it('PENDING e CONFIRMED seguram o horário; CANCELLED, COMPLETED e NO_SHOW não', async () => {
    const w = await world('hold');
    const pending = await schedule.createAppointment(w.company.id, w.owner.id, {
      serviceId: w.serviceId,
      resourceId: w.resourceId,
      localStart: '2026-12-01T10:00',
      status: 'PENDING',
    });
    assert.equal(pending.status, 'PENDING');
    await assert.rejects(book(w, '2026-12-01T10:00'), isSlotTaken);
    // Fora da aplicação: os estados que liberam aceitam um item sobreposto, direto por SQL.
    const insert = (status: string, extraCancelled: boolean) =>
      sql.query(
        `INSERT INTO appointments (id, company_id, resource_id, service_id, kind, status, starts_at, ends_at, blocked_until,
                                   source, created_by_membership_id, cancelled_at, updated_at)
         VALUES ($1, $2, $3, $4, 'BOOKING', $5, $6, $7, $7, 'PANEL', $8, $9, now())`,
        [
          randomUUID(),
          w.company.id,
          w.resourceId,
          w.serviceId,
          status,
          pending.startsAt,
          pending.endsAt,
          w.owner.id,
          extraCancelled ? new Date() : null,
        ],
      );
    await insert('CANCELLED', true);
    await insert('COMPLETED', false);
    await insert('NO_SHOW', false);
    assert.equal(await activeCount(w.resourceId), 1);
  });
});

describe('remarcar e bloquear (spec 027, E1)', () => {
  it('remarcar muda a mesma linha; para horário ocupado, 409 e o horário antigo continua', async () => {
    const w = await world('resched');
    const first = await book(w, '2026-12-01T10:00');
    await book(w, '2026-12-01T12:00');
    const moved = await schedule.updateAppointment(w.company.id, w.owner.id, first.id, {
      localStart: '2026-12-01T11:00',
    });
    assert.equal(moved.id, first.id);
    assert.equal(moved.startsAt.toISOString(), '2026-12-01T14:00:00.000Z');
    assert.equal(moved.endsAt.getTime() - moved.startsAt.getTime(), 30 * 60_000);
    await assert.rejects(
      schedule.updateAppointment(w.company.id, w.owner.id, first.id, {
        localStart: '2026-12-01T12:00',
      }),
      isSlotTaken,
    );
    const stored = await appointments.findById(w.company.id, first.id);
    assert.equal(stored.startsAt.toISOString(), '2026-12-01T14:00:00.000Z');
    assert.equal(stored.createdAt.getTime(), first.createdAt.getTime());
    // Remarcar para o passado: IN_THE_PAST.
    await assert.rejects(
      schedule.updateAppointment(w.company.id, w.owner.id, first.id, {
        localStart: '2026-11-01T10:00',
      }),
      (error: unknown) => error instanceof ValidationError && error.code === 'IN_THE_PAST',
    );
  });

  it('remarcação simultânea de dois para o mesmo destino: um ganha; cruzadas terminam sem deadlock pendente', async () => {
    const w = await world('resched-conc');
    const a = await book(w, '2026-12-01T09:00');
    const b = await book(w, '2026-12-01T10:00');
    const same = await Promise.allSettled([
      schedule.updateAppointment(w.company.id, w.owner.id, a.id, {
        localStart: '2026-12-01T14:00',
      }),
      schedule.updateAppointment(w.company.id, w.owner.id, b.id, {
        localStart: '2026-12-01T14:00',
      }),
    ]);
    assert.equal(same.filter((result) => result.status === 'fulfilled').length, 1);
    for (const result of same) {
      if (result.status === 'rejected') assert.ok(isSlotTaken(result.reason));
    }
    // Cruzadas: A para o lugar de B e B para o de A.
    const c = await book(w, '2026-12-02T09:00');
    const d = await book(w, '2026-12-02T10:00');
    const crossed = await Promise.allSettled([
      schedule.updateAppointment(w.company.id, w.owner.id, c.id, {
        localStart: '2026-12-02T10:00',
      }),
      schedule.updateAppointment(w.company.id, w.owner.id, d.id, {
        localStart: '2026-12-02T09:00',
      }),
    ]);
    for (const result of crossed) {
      if (result.status === 'rejected') assert.ok(isSlotTaken(result.reason));
    }
    const overlapping = await sql.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM appointments x JOIN appointments y
         ON x.resource_id = y.resource_id AND x.id < y.id
        WHERE x.resource_id = $1 AND x.status IN ('PENDING','CONFIRMED') AND y.status IN ('PENDING','CONFIRMED')
          AND tstzrange(x.starts_at, x.blocked_until) && tstzrange(y.starts_at, y.blocked_until)`,
      [w.resourceId],
    );
    assert.equal(overlapping.rows[0]?.count, '0');
  });

  it('bloqueio contra reserva: um não passa por cima do outro; vários recursos é tudo ou nada', async () => {
    const w = await world('block');
    const second = await schedule.createResource(w.company.id, { name: 'Sala 2' });
    await book(w, '2026-12-01T10:00');
    await assert.rejects(
      schedule.createBlocks(w.company.id, w.owner.id, {
        resourceIds: [w.resourceId],
        localStart: '2026-12-01T09:00',
        localEnd: '2026-12-01T11:00',
      }),
      isSlotTaken,
    );
    const blocks = await schedule.createBlocks(w.company.id, w.owner.id, {
      resourceIds: [w.resourceId],
      localStart: '2026-12-01T12:00',
      localEnd: '2026-12-01T13:00',
    });
    assert.equal(blocks.length, 1);
    await assert.rejects(book(w, '2026-12-01T12:30'), isSlotTaken);
    // Tudo ou nada: o recurso 2 está livre, o 1 está ocupado às 10h; nada é gravado no recurso 2.
    await assert.rejects(
      schedule.createBlocks(w.company.id, w.owner.id, {
        resourceIds: [second.id, w.resourceId],
        localStart: '2026-12-01T10:00',
        localEnd: '2026-12-01T10:30',
      }),
      isSlotTaken,
    );
    const onSecond = await sql.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM appointments WHERE resource_id = $1`,
      [second.id],
    );
    assert.equal(onSecond.rows[0]?.count, '0');
    // Cancelar o bloqueio (idempotente) libera o horário.
    const block = blocks[0];
    assert.ok(block !== undefined);
    await schedule.cancelBlock(w.company.id, w.owner.id, block.id);
    await schedule.cancelBlock(w.company.id, w.owner.id, block.id);
    await book(w, '2026-12-01T12:30');
    // Agendamento (não bloqueio) pelo caminho de bloqueio: 404 uniforme.
    const booking = await book(w, '2026-12-03T10:00');
    await assert.rejects(
      schedule.cancelBlock(w.company.id, w.owner.id, booking.id),
      (error: unknown) => error instanceof NotFoundError,
    );
  });

  it('transições, rótulo e regras de estado', async () => {
    const w = await world('trans');
    const item = await book(w, '2026-12-01T10:00');
    await assert.rejects(
      schedule.updateAppointment(w.company.id, w.owner.id, item.id, { status: 'COMPLETED' }),
      (error: unknown) => error instanceof ConflictError && error.code === 'INVALID_TRANSITION',
    );
    const labelled = await schedule.updateAppointment(w.company.id, w.owner.id, item.id, {
      customerLabel: 'Maria',
    });
    assert.equal(labelled.customerLabel, 'Maria');
    // Depois do início, concluir vale; depois de concluído, cancelar não.
    const later = buildService(appointments);
    clock = new Date('2026-12-02T00:00:00.000Z');
    try {
      const done = await later.updateAppointment(w.company.id, w.owner.id, item.id, {
        status: 'COMPLETED',
      });
      assert.equal(done.status, 'COMPLETED');
      await assert.rejects(
        later.updateAppointment(w.company.id, w.owner.id, item.id, { status: 'CANCELLED' }),
        (error: unknown) => error instanceof ConflictError && error.code === 'INVALID_TRANSITION',
      );
    } finally {
      clock = NOW;
    }
    const cancelled = await book(w, '2026-12-03T10:00');
    await schedule.updateAppointment(w.company.id, w.owner.id, cancelled.id, {
      status: 'CANCELLED',
    });
    await assert.rejects(
      schedule.updateAppointment(w.company.id, w.owner.id, cancelled.id, { status: 'CONFIRMED' }),
      (error: unknown) => error instanceof ConflictError && error.code === 'INVALID_TRANSITION',
    );
    // No passado: IN_THE_PAST.
    await assert.rejects(
      book(w, '2026-11-01T10:00'),
      (error: unknown) => error instanceof ValidationError && error.code === 'IN_THE_PAST',
    );
  });

  it('recurso com agendamento futuro não desativa; serviço desativado segue nos agendamentos e deixa de ser oferecido', async () => {
    const w = await world('inactive');
    const item = await book(w, '2026-12-01T10:00');
    await assert.rejects(
      schedule.updateResource(w.company.id, w.resourceId, { active: false }),
      (error: unknown) =>
        error instanceof ConflictError && error.code === 'RESOURCE_HAS_APPOINTMENTS',
    );
    await schedule.updateService(w.company.id, w.serviceId, { active: false });
    const listed = await schedule.listAppointments(w.company.id, {
      from: '2026-12-01',
      to: '2026-12-01',
    });
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0]?.id, item.id);
    assert.equal(listed.items[0].serviceName, 'Corte de cabelo');
    await assert.rejects(
      book(w, '2026-12-02T10:00'),
      (error: unknown) => error instanceof ConflictError && error.code === 'SERVICE_INACTIVE',
    );
    await schedule.updateAppointment(w.company.id, w.owner.id, item.id, { status: 'CANCELLED' });
    const off = await schedule.updateResource(w.company.id, w.resourceId, { active: false });
    assert.equal(off.active, false);
    await schedule.updateService(w.company.id, w.serviceId, { active: true });
    await assert.rejects(
      book(w, '2026-12-02T10:00'),
      (error: unknown) => error instanceof ConflictError && error.code === 'RESOURCE_INACTIVE',
    );
  });
});

describe('limites (spec 027, E1)', () => {
  it('20 recursos por empresa; o 21º é SCHEDULE_LIMIT_REACHED', async () => {
    const w = await world('limit-res');
    for (let index = 1; index < SCHEDULE_MAX_RESOURCES; index += 1) {
      await schedule.createResource(w.company.id, { name: `Sala ${String(index)}` });
    }
    await assert.rejects(
      schedule.createResource(w.company.id, { name: 'Sala extra' }),
      (error: unknown) => error instanceof ConflictError && error.code === 'SCHEDULE_LIMIT_REACHED',
    );
  });

  it('teto de agendamentos ativos futuros por empresa', async () => {
    const w = await world('limit-appt');
    const full: AppointmentRepository = Object.assign(
      Object.create(appointments) as AppointmentRepository,
      { countActiveFuture: () => Promise.resolve(SCHEDULE_MAX_ACTIVE_FUTURE) },
    );
    const limited = buildService(full);
    await assert.rejects(
      limited.createAppointment(w.company.id, w.owner.id, {
        serviceId: w.serviceId,
        resourceId: w.resourceId,
        localStart: '2026-12-01T10:00',
      }),
      (error: unknown) => error instanceof ConflictError && error.code === 'SCHEDULE_LIMIT_REACHED',
    );
  });

  it('janelas: o último PUT ganha por transação e nunca fica um conjunto misto', async () => {
    const w = await world('rules');
    const sets = [1, 2, 3, 4, 5, 6].map((count) =>
      Array.from({ length: count }, (_, index) => ({
        weekday: 2,
        start: (8 + index) * 60,
        end: (8 + index) * 60 + 30,
      })),
    );
    await Promise.all(
      sets.map((windows) => schedule.setRules(w.company.id, w.resourceId, windows)),
    );
    const [view] = await schedule.listResources(w.company.id);
    assert.ok([1, 2, 3, 4, 5, 6].includes(view?.windows.length ?? 0));
    // As janelas gravadas são exatamente as de um dos conjuntos (nunca uma mistura).
    const starts = view?.windows.map((window) => window.start).join(',');
    assert.ok(
      sets.some(
        (windows) =>
          windows
            .map((window) => `${String(Math.floor(window.start / 60)).padStart(2, '0')}:00`)
            .join(',') === starts,
      ),
    );
    await assert.rejects(
      schedule.setRules(w.company.id, w.resourceId, [
        { weekday: 2, start: 9 * 60, end: 11 * 60 },
        { weekday: 2, start: 10 * 60, end: 12 * 60 },
      ]),
      (error: unknown) => error instanceof ValidationError && error.code === 'INVALID_WINDOWS',
    );
  });
});

describe('fuso e horários livres (spec 027, E1)', () => {
  it('a mesma regra 9h-12h dá instantes diferentes em fusos diferentes, e trocar o fuso não move o agendamento', async () => {
    const a = await world('tz-a');
    const b = await world('tz-b');
    await schedule.updateSettings(b.company.id, {
      timezone: 'America/New_York',
      slotStepMinutes: 30,
      minNoticeMinutes: 120,
      maxAdvanceDays: 60,
    });
    for (const w of [a, b]) {
      await schedule.setRules(w.company.id, w.resourceId, [{ weekday: 2, start: 540, end: 720 }]);
    }
    const query = (w: World) => ({
      serviceId: w.serviceId,
      from: '2026-12-01',
      to: '2026-12-01',
    });
    const inSaoPaulo = await schedule.availability(a.company.id, query(a));
    const inNewYork = await schedule.availability(b.company.id, query(b));
    assert.equal(inSaoPaulo.slots[0]?.localStart, '09:00');
    assert.equal(inNewYork.slots[0]?.localStart, '09:00');
    assert.equal(inSaoPaulo.slots[0].startsAt.toISOString(), '2026-12-01T12:00:00.000Z');
    assert.equal(inNewYork.slots[0].startsAt.toISOString(), '2026-12-01T14:00:00.000Z');
    assert.equal(inSaoPaulo.slots.length, 6);
    // `localStart` é interpretado no fuso da empresa (Nova York), nunca no do processo.
    const ny = await book(b, '2026-12-01T10:00');
    assert.equal(ny.startsAt.toISOString(), '2026-12-01T15:00:00.000Z');
    // Trocar o fuso não move o instante gravado; só muda a hora local mostrada.
    await schedule.updateSettings(a.company.id, {
      timezone: 'America/Manaus',
      slotStepMinutes: 30,
      minNoticeMinutes: 120,
      maxAdvanceDays: 60,
    });
    const kept = await book(a, '2026-12-01T10:00');
    await schedule.updateSettings(a.company.id, {
      timezone: 'America/Sao_Paulo',
      slotStepMinutes: 30,
      minNoticeMinutes: 120,
      maxAdvanceDays: 60,
    });
    const listed = await schedule.listAppointments(a.company.id, {
      from: '2026-12-01',
      to: '2026-12-01',
    });
    assert.equal(listed.items[0]?.startsAt.toISOString(), kept.startsAt.toISOString());
    assert.equal(listed.items[0].localStart, '11:00');
    await assert.rejects(
      schedule.updateSettings(a.company.id, {
        timezone: 'Mars/Olympus',
        slotStepMinutes: 30,
        minNoticeMinutes: 120,
        maxAdvanceDays: 60,
      }),
      (error: unknown) => error instanceof ValidationError && error.code === 'INVALID_TIMEZONE',
    );
  });

  it('o horário reservado sai da lista; o horário que cabe na janela e está livre continua', async () => {
    const w = await world('avail');
    await schedule.setRules(w.company.id, w.resourceId, [{ weekday: 2, start: 540, end: 720 }]);
    const query = { serviceId: w.serviceId, from: '2026-12-01', to: '2026-12-01' };
    const before = (await schedule.availability(w.company.id, query)).slots.map(
      (slot) => slot.localStart,
    );
    assert.deepEqual(before, ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
    await book(w, '2026-12-01T10:00');
    const after = (await schedule.availability(w.company.id, query)).slots.map(
      (slot) => slot.localStart,
    );
    assert.deepEqual(after, ['09:00', '09:30', '10:30', '11:00', '11:30']);
    await assert.rejects(
      schedule.availability(w.company.id, { ...query, to: '2026-12-20' }),
      (error: unknown) => error instanceof ValidationError && error.code === 'RANGE_TOO_LARGE',
    );
  });
});

describe('isolamento entre empresas (spec 027, E1)', () => {
  it('A não enxerga nada da B; ids da outra empresa são 404; availability ignora o que é da B', async () => {
    const a = await world('iso-a');
    const b = await world('iso-b');
    for (const w of [a, b]) {
      await schedule.setRules(w.company.id, w.resourceId, [{ weekday: 2, start: 540, end: 720 }]);
    }
    const ofB = await book(b, '2026-12-01T10:00');
    const query = { serviceId: a.serviceId, from: '2026-12-01', to: '2026-12-01' };
    const slots = (await schedule.availability(a.company.id, query)).slots.map(
      (slot) => slot.localStart,
    );
    assert.ok(slots.includes('10:00'), 'o horário da B não bloqueia a A');
    assert.deepEqual(
      (await schedule.listAppointments(a.company.id, { from: '2026-12-01', to: '2026-12-01' }))
        .items,
      [],
    );
    const notFound = (error: unknown): boolean => error instanceof NotFoundError;
    await assert.rejects(
      schedule.updateAppointment(a.company.id, a.owner.id, ofB.id, { status: 'CANCELLED' }),
      notFound,
    );
    await assert.rejects(
      schedule.updateAppointment(a.company.id, a.owner.id, ofB.id, {
        localStart: '2026-12-02T10:00',
      }),
      notFound,
    );
    await assert.rejects(schedule.cancelBlock(a.company.id, a.owner.id, ofB.id), notFound);
    await assert.rejects(book(a, '2026-12-05T10:00', { serviceId: b.serviceId }), notFound);
    await assert.rejects(book(a, '2026-12-05T10:00', { resourceId: b.resourceId }), notFound);
    await assert.rejects(
      schedule.updateResource(a.company.id, b.resourceId, { name: 'x' }),
      notFound,
    );
    await assert.rejects(
      schedule.updateService(a.company.id, b.serviceId, { name: 'x' }),
      notFound,
    );
    await assert.rejects(schedule.setRules(a.company.id, b.resourceId, []), notFound);
    await assert.rejects(
      schedule.availability(a.company.id, { ...query, serviceId: b.serviceId }),
      notFound,
    );
    await assert.rejects(
      schedule.availability(a.company.id, { ...query, resourceId: b.resourceId }),
      notFound,
    );
    await assert.rejects(appointments.findById(a.company.id, ofB.id), notFound);
    // As regras e a lista de recursos da B não aparecem na A.
    const listA = await schedule.listResources(a.company.id);
    assert.ok(listA.every((resource) => resource.id !== b.resourceId));
  });

  it('as chaves estrangeiras compostas recusam, por INSERT direto, serviço, recurso e vínculo de outra empresa', async () => {
    const a = await world('fk-a');
    const b = await world('fk-b');
    const insert = (service: string, resource: string, member: string) =>
      sql.query(
        `INSERT INTO appointments (id, company_id, resource_id, service_id, kind, status, starts_at, ends_at, blocked_until,
                                   source, created_by_membership_id, updated_at)
         VALUES ($1, $2, $3, $4, 'BOOKING', 'CONFIRMED', '2026-12-10T10:00:00Z', '2026-12-10T10:30:00Z', '2026-12-10T10:30:00Z',
                 'PANEL', $5, now())`,
        [randomUUID(), a.company.id, resource, service, member],
      );
    const foreignKey = (error: unknown): boolean =>
      typeof error === 'object' && error !== null && 'code' in error && error.code === '23503';
    await assert.rejects(insert(b.serviceId, a.resourceId, a.owner.id), foreignKey);
    await assert.rejects(insert(a.serviceId, b.resourceId, a.owner.id), foreignKey);
    await assert.rejects(insert(a.serviceId, a.resourceId, b.owner.id), foreignKey);
    await insert(a.serviceId, a.resourceId, a.owner.id);
  });
});

describe('o banco recusa por si só (spec 027, E1)', () => {
  it('INSERT direto sobreposto é 23P01; CHECKs recusam intervalo invertido, bloqueio com serviço e reserva sem serviço', async () => {
    const w = await world('raw');
    const insert = (columns: {
      kind: 'BOOKING' | 'BLOCK';
      service: string | null;
      starts: string;
      ends: string;
      blocked?: string;
      contact?: string | null;
      source?: 'PANEL' | 'CHANNEL';
    }) =>
      sql.query(
        `INSERT INTO appointments (id, company_id, resource_id, service_id, kind, status, starts_at, ends_at, blocked_until,
                                   contact_ref, source, created_by_membership_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'CONFIRMED', $6, $7, $8, $9, $10, $11, now())`,
        [
          randomUUID(),
          w.company.id,
          w.resourceId,
          columns.service,
          columns.kind,
          columns.starts,
          columns.ends,
          columns.blocked ?? columns.ends,
          columns.contact ?? null,
          columns.source ?? 'PANEL',
          (columns.source ?? 'PANEL') === 'PANEL' ? w.owner.id : null,
        ],
      );
    const code = (expected: string) => (error: unknown) =>
      typeof error === 'object' && error !== null && 'code' in error && error.code === expected;
    await insert({
      kind: 'BOOKING',
      service: w.serviceId,
      starts: '2026-12-10T10:00:00Z',
      ends: '2026-12-10T10:30:00Z',
    });
    await assert.rejects(
      insert({
        kind: 'BOOKING',
        service: w.serviceId,
        starts: '2026-12-10T10:15:00Z',
        ends: '2026-12-10T10:45:00Z',
      }),
      code('23P01'),
    );
    await assert.rejects(
      insert({
        kind: 'BLOCK',
        service: null,
        starts: '2026-12-10T10:00:00Z',
        ends: '2026-12-10T10:10:00Z',
      }),
      code('23P01'),
    );
    await assert.rejects(
      insert({
        kind: 'BOOKING',
        service: w.serviceId,
        starts: '2026-12-11T10:30:00Z',
        ends: '2026-12-11T10:00:00Z',
      }),
      code('23514'),
    );
    await assert.rejects(
      insert({
        kind: 'BOOKING',
        service: w.serviceId,
        starts: '2026-12-11T10:00:00Z',
        ends: '2026-12-11T10:30:00Z',
        blocked: '2026-12-11T10:20:00Z',
      }),
      code('23514'),
    );
    await assert.rejects(
      insert({
        kind: 'BLOCK',
        service: w.serviceId,
        starts: '2026-12-12T10:00:00Z',
        ends: '2026-12-12T10:30:00Z',
      }),
      code('23514'),
    );
    await assert.rejects(
      insert({
        kind: 'BOOKING',
        service: null,
        starts: '2026-12-12T10:00:00Z',
        ends: '2026-12-12T10:30:00Z',
      }),
      code('23514'),
    );
    await assert.rejects(
      insert({
        kind: 'BLOCK',
        service: null,
        starts: '2026-12-12T10:00:00Z',
        ends: '2026-12-12T10:30:00Z',
        contact: '5511999990000',
      }),
      code('23514'),
    );
  });

  it('a consulta de agendamentos por intervalo usa índice', async () => {
    const w = await world('explain');
    await book(w, '2026-12-01T10:00');
    await sql.query('BEGIN');
    try {
      await sql.query('SET LOCAL enable_seqscan = off');
      const plan = await sql.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT id FROM appointments
          WHERE company_id = $1 AND starts_at >= '2026-12-01' AND starts_at < '2026-12-08' ORDER BY starts_at, id`,
        [w.company.id],
      );
      const text = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
      assert.match(
        text,
        /appointments_company_id_starts_at_id_idx|appointments_company_id_resource_id_starts_at_idx/,
      );
    } finally {
      await sql.query('ROLLBACK');
    }
  });
});

describe('privacidade (spec 027, todas as etapas)', () => {
  it('nome de serviço, rótulo, contato e horários nunca aparecem em log; o contato sai mascarado e `contactRef` nunca sai', async () => {
    const w = await world('priv', { name: SECRET_SERVICE });
    const item = await schedule.createAppointment(w.company.id, w.owner.id, {
      serviceId: w.serviceId,
      resourceId: w.resourceId,
      localStart: '2026-12-01T10:17',
      customerLabel: SECRET_LABEL,
    });
    await assert.rejects(
      schedule.createAppointment(w.company.id, w.owner.id, {
        serviceId: w.serviceId,
        resourceId: w.resourceId,
        localStart: '2026-12-01T10:17',
        customerLabel: SECRET_LABEL,
      }),
      isSlotTaken,
    );
    await schedule.updateAppointment(w.company.id, w.owner.id, item.id, {
      localStart: '2026-12-01T13:41',
    });
    await schedule.updateAppointment(w.company.id, w.owner.id, item.id, { status: 'CANCELLED' });
    // Um agendamento do canal (Anexo B) é gravado direto, só para provar a máscara.
    await sql.query(
      `INSERT INTO appointments (id, company_id, resource_id, service_id, kind, status, starts_at, ends_at, blocked_until,
                                 contact_ref, source, updated_at)
       VALUES ($1, $2, $3, $4, 'BOOKING', 'PENDING', '2026-12-04T13:00:00Z', '2026-12-04T13:30:00Z', '2026-12-04T13:30:00Z',
               $5, 'CHANNEL', now())`,
      [randomUUID(), w.company.id, w.resourceId, w.serviceId, SECRET_CONTACT],
    );
    const listed = await schedule.listAppointments(w.company.id, {
      from: '2026-12-04',
      to: '2026-12-04',
    });
    const channel = listed.items[0];
    assert.equal(channel?.contactLabel, `Contato final ${SECRET_CONTACT.slice(-4)}`);
    assert.equal(JSON.stringify(listed).includes(SECRET_CONTACT), false);
    const raw = logs.raw();
    for (const secret of [
      SECRET_SERVICE,
      SECRET_LABEL,
      SECRET_CONTACT,
      '10:17',
      '13:41',
      '2026-12-01',
    ]) {
      assert.equal(logContains(raw, secret), false, `vazou em log: ${secret}`);
    }
    assert.ok(logs.lines().some((line) => line['msg'] === 'agendamento criado'));
    // Métrica: só os rótulos esperados, nunca valor de dado.
    const text = await metrics.render();
    const labels = [...text.matchAll(/^schedule_actions_total\{([^}]*)\}/gm)].map(
      (match) => match[1] ?? '',
    );
    assert.ok(labels.length > 0);
    for (const label of labels) assert.match(label, /^action="[a-z_]+",result="[a-z_]+"$/);
    assert.equal(text.includes(SECRET_SERVICE), false);
  });
});

describe('visão de um agendamento', () => {
  it('traz os campos locais já calculados pelo servidor', async () => {
    const w = await world('view');
    const created: Appointment = await book(w, '2026-12-01T23:30');
    const view = await schedule.view(w.company.id, created);
    assert.equal(view.localDate, '2026-12-01');
    assert.equal(view.localStart, '23:30');
    assert.equal(view.localEnd, '00:00');
    assert.equal(view.weekday, 2);
    assert.equal(view.startsAt.toISOString(), '2026-12-02T02:30:00.000Z');
  });
});

describe('intervalos máximos (spec 027, E1)', () => {
  it('a lista de agendamentos recusa intervalo acima de 42 dias com RANGE_TOO_LARGE', async () => {
    const w = await world('range');
    await assert.rejects(
      schedule.listAppointments(w.company.id, { from: '2026-12-01', to: '2027-01-12' }),
      (error: unknown) => error instanceof ValidationError && error.code === 'RANGE_TOO_LARGE',
    );
    // 42 dias exatos passam.
    const ok = await schedule.listAppointments(w.company.id, {
      from: '2026-12-01',
      to: '2027-01-11',
    });
    assert.deepEqual(ok.items, []);
    // `today` é a data local da empresa (o navegador não calcula fuso): 08:00 em São Paulo, segunda 2026-11-09.
    assert.equal(ok.today, '2026-11-09');
    assert.equal((await schedule.getSettings(w.company.id)).today, '2026-11-09');
  });
});
