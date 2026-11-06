import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  ContactSchedulingService,
  type ContactOutcome,
} from '../../application/schedule/contact-scheduling.service.js';
import { ScheduleService } from '../../application/schedule/schedule.service.js';
import type { ScheduleAiQuotaStore } from '../../application/ports/contact-scheduling.js';
import type { Company, CompanyId } from '../../domain/index.js';
import { ServiceUnavailableError } from '../../shared/errors/index.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { TestKeyspace } from '../../test-support/test-keyspace.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import { createAuthRedis } from '../auth/auth-redis.js';
import { RedisScheduleAiQuotaStore } from '../auth/redis-schedule-ai-quota.js';
import { createRedis, type RedisHandle } from '../cache/redis.client.js';
import { createLogger } from '../logger/logger.js';
import { createDatabase, type Database } from './database.js';
import { PrismaCompanyRepository } from './repositories/company.repository.js';
import { PrismaContactScheduleUnitOfWork } from './repositories/contact-schedule-unit-of-work.js';
import { PrismaMembershipRepository } from './repositories/membership.repository.js';
import {
  PrismaAppointmentRepository,
  PrismaAvailabilityRuleRepository,
  PrismaScheduleResourceRepository,
  PrismaScheduleServiceRepository,
  PrismaScheduleSettingsRepository,
} from './repositories/schedule.repository.js';

// Spec 028 (E2/E3): as escritas da IA na agenda contra Postgres e Redis reais (soprei_test e /15).
const config = loadIntegrationConfig();
// Segunda-feira 2026-11-09, 08:00 em São Paulo (UTC-3).
const NOW = new Date('2026-11-09T11:00:00.000Z');
const SUFFIX = randomBytes(4).toString('hex');
const HASH = 'scrypt$1024$8$1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA==';
const keyspace = new TestKeyspace();
const logs = captureLogs();

let database: Database;
let tenants: TestTenants;
let redis: RedisHandle;
let authClosers: (() => Promise<void>)[] = [];
let schedule: ScheduleService;
let appointments: PrismaAppointmentRepository;
let ai: ContactSchedulingService;
let quotaStore: RedisScheduleAiQuotaStore;
let companies: PrismaCompanyRepository;
let memberships: PrismaMembershipRepository;

before(async () => {
  // Pool maior que as escritas simultâneas dos testes de concorrência (padrão 10 + prazo de 5 s falharia
  // por conexão, não por SLOT_TAKEN).
  database = createDatabase(
    { ...config, DB_POOL_MAX: 30, DB_POOL_CONNECTION_TIMEOUT_MS: 30_000 },
    createLogger(config),
  );
  tenants = new TestTenants(database.prisma);
  redis = createRedis(config, captureLogs().logger);
  const handle = createAuthRedis(config, captureLogs().logger);
  authClosers = [() => handle.close()];
  assert.ok(await handle.waitUntilReady(5_000));
  appointments = new PrismaAppointmentRepository(database.prisma);
  companies = new PrismaCompanyRepository(database.prisma);
  memberships = new PrismaMembershipRepository(database.prisma);
  schedule = new ScheduleService({
    settings: new PrismaScheduleSettingsRepository(database.prisma),
    resources: new PrismaScheduleResourceRepository(database.prisma),
    services: new PrismaScheduleServiceRepository(database.prisma),
    rules: new PrismaAvailabilityRuleRepository(database.prisma),
    appointments,
    logger: logs.logger,
    now: () => NOW,
  });
  quotaStore = new RedisScheduleAiQuotaStore(handle.client, keyspace.scopedPrefix('sched-ai'));
  ai = buildAi(quotaStore);
});

after(async () => {
  try {
    await tenants.cleanup();
    await keyspace.cleanup(redis.client);
  } finally {
    for (const close of authClosers) await close();
    await redis.close();
    await database.close();
  }
});

function buildAi(
  quota: ScheduleAiQuotaStore,
  now: () => Date = () => NOW,
): ContactSchedulingService {
  return new ContactSchedulingService({
    unitOfWork: new PrismaContactScheduleUnitOfWork(database.prisma),
    quota,
    quotaSecret: 'segredo-de-teste-das-cotas',
    now,
  });
}

interface World {
  readonly company: Company;
  readonly resourceId: string;
  readonly serviceId: string;
  readonly serviceName: string;
  readonly ownerId: string;
}

/** Empresa com a IA ligada, uma "Agenda principal" aberta de terça a sexta, das 09:00 às 12:00 (6 horários), e um serviço de 30 min. */
async function world(
  label: string,
  options: { autoConfirm?: boolean; ai?: boolean; serviceName?: string } = {},
): Promise<World> {
  const company = await tenants.createCompany(label);
  const owner = await memberships.create(company.id, {
    email: `${label}-${randomBytes(5).toString('hex')}@exemplo.test`,
    passwordHash: HASH,
    role: 'OWNER',
  });
  const [main] = await schedule.listResources(company.id);
  assert.ok(main !== undefined);
  const serviceName = options.serviceName ?? `Corte ${SUFFIX}`;
  const service = await schedule.createService(company.id, {
    name: serviceName,
    durationMinutes: 30,
    bufferMinutes: 0,
  });
  await schedule.setRules(
    company.id,
    main.id,
    [2, 3, 4, 5].map((weekday) => ({ weekday, start: 540, end: 720 })),
  );
  const current = await schedule.getSettings(company.id);
  await schedule.updateSettings(company.id, {
    timezone: current.timezone,
    slotStepMinutes: 30,
    minNoticeMinutes: 120,
    maxAdvanceDays: 60,
    aiBookingEnabled: options.ai ?? true,
    aiAutoConfirm: options.autoConfirm ?? false,
  });
  return { company, resourceId: main.id, serviceId: service.id, serviceName, ownerId: owner.id };
}

const contact = (label: string): string => `5511${label}${randomBytes(3).toString('hex')}`;

async function rows(companyId: CompanyId, contactRef?: string) {
  return database.prisma.appointment.findMany({
    where: { companyId, ...(contactRef === undefined ? {} : { contactRef }) },
    orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
  });
}

const active = <T extends { status: string }>(list: T[]): T[] =>
  list.filter((row) => row.status === 'PENDING' || row.status === 'CONFIRMED');

const book = (w: World, contactRef: string, start: string, label: string | null = null) =>
  ai.request(w.company.id, contactRef, { serviceName: w.serviceName, start, customerLabel: label });

/** Dia útil futuro (terça 2026-11-10 em diante). Horários de 09:00 a 11:30 a cada 30 min. */
const slot = (day: number, time: string): string =>
  `2026-11-${String(day).padStart(2, '0')}T${time}`;

function expectKind<K extends ContactOutcome['kind']>(
  outcome: ContactOutcome,
  kind: K,
): Extract<ContactOutcome, { kind: K }> {
  assert.equal(outcome.kind, kind, `esperava ${kind}, veio ${outcome.kind}`);
  return outcome as Extract<ContactOutcome, { kind: K }>;
}

describe('solicitar_agendamento: gravação, estado e idempotência (E2)', () => {
  it('grava PENDING, origem CHANNEL, contato e nome; com a opção da empresa, CONFIRMED', async () => {
    const w = await world('ai-state');
    const ref = contact('01');
    const done = expectKind(await book(w, ref, slot(10, '09:00'), 'Maria'), 'booked');
    assert.equal(done.already, false);
    assert.equal(done.booked.localStart, '09:00');
    assert.equal(done.booked.status, 'PENDING');
    const [row] = await rows(w.company.id, ref);
    assert.equal(row?.status, 'PENDING');
    assert.equal(row.source, 'CHANNEL');
    assert.equal(row.contactRef, ref);
    assert.equal(row.customerLabel, 'Maria');
    assert.equal(row.createdByMembershipId, null);
    assert.equal(row.serviceId, w.serviceId);

    const auto = await world('ai-auto', { autoConfirm: true });
    const confirmed = expectKind(await book(auto, contact('02'), slot(10, '10:00')), 'booked');
    assert.equal(confirmed.booked.status, 'CONFIRMED');
    assert.equal((await rows(auto.company.id))[0]?.status, 'CONFIRMED');
  });

  it('sem a opção da empresa (ou empresa suspensa) nada é gravado', async () => {
    const off = await world('ai-off', { ai: false });
    expectKind(await book(off, contact('03'), slot(10, '09:00')), 'unavailable');
    assert.equal((await rows(off.company.id)).length, 0);

    const suspended = await world('ai-susp');
    await companies.update(suspended.company.id, { status: 'SUSPENDED' });
    expectKind(await book(suspended, contact('04'), slot(10, '09:00')), 'unavailable');
    assert.equal((await rows(suspended.company.id)).length, 0);
  });

  it('o mesmo pedido, em sequência e em paralelo, deixa uma linha ativa e todas as respostas ok', async () => {
    const w = await world('ai-idem');
    const ref = contact('05');
    const first = expectKind(await book(w, ref, slot(10, '09:30')), 'booked');
    const second = expectKind(await book(w, ref, slot(10, '09:30')), 'booked');
    assert.equal(first.already, false);
    assert.equal(second.already, true);

    const parallel = await Promise.all(
      Array.from({ length: 5 }, () => book(w, ref, slot(11, '10:00'))),
    );
    for (const outcome of parallel) expectKind(outcome, 'booked');
    assert.equal(
      parallel.filter((outcome) => outcome.kind === 'booked' && !outcome.already).length,
      1,
    );
    const mine = active(await rows(w.company.id, ref));
    assert.equal(mine.length, 2, 'duas reservas distintas, cada uma uma só vez');
  });

  it('horário ocupado (por outro contato ou pelo painel): slot_ocupado com até 3 alternativas e nada gravado', async () => {
    const w = await world('ai-taken');
    const other = contact('06');
    expectKind(await book(w, other, slot(10, '09:00')), 'booked');
    const taken = expectKind(await book(w, contact('07'), slot(10, '09:00')), 'slot_taken');
    assert.ok(taken.alternatives.length >= 1 && taken.alternatives.length <= 3);
    assert.ok(
      !taken.alternatives.some(
        (alt) => alt.localDate === '2026-11-10' && alt.localStart === '09:00',
      ),
    );
    assert.equal(JSON.stringify(taken).includes('violates'), false);

    // O painel também ocupa o horário (mesma restrição do banco).
    await schedule.createAppointment(w.company.id, w.ownerId, {
      serviceId: w.serviceId,
      resourceId: w.resourceId,
      localStart: slot(10, '10:00'),
      status: 'CONFIRMED',
    });
    expectKind(await book(w, contact('08'), slot(10, '10:00')), 'slot_taken');
    assert.equal(active(await rows(w.company.id)).length, 2);
  });

  it('duas conversas disputam o mesmo horário: exatamente uma reserva ativa', async () => {
    const w = await world('ai-race');
    const results = await Promise.all([
      book(w, contact('09'), slot(11, '09:00')),
      book(w, contact('10'), slot(11, '09:00')),
      book(w, contact('11'), slot(11, '09:00')),
    ]);
    const kinds = results.map((outcome) => outcome.kind).toSorted();
    assert.deepEqual(kinds, ['booked', 'slot_taken', 'slot_taken'], JSON.stringify(kinds));
    assert.equal(active(await rows(w.company.id)).length, 1);
    for (const outcome of results) {
      if (outcome.kind === 'slot_taken') assert.ok(outcome.alternatives.length <= 3);
    }
  });

  it('corrida contra o painel pelo mesmo horário: uma só ativa e a IA nunca vê a mensagem do Postgres', async () => {
    const w = await world('ai-panel-race');
    const [outcome] = await Promise.all([
      book(w, contact('12'), slot(12, '09:00')),
      schedule
        .createAppointment(w.company.id, w.ownerId, {
          serviceId: w.serviceId,
          resourceId: w.resourceId,
          localStart: slot(12, '09:00'),
          status: 'CONFIRMED',
        })
        .catch((error: unknown) => error),
    ]);
    assert.ok(outcome.kind === 'booked' || outcome.kind === 'slot_taken');
    assert.equal(active(await rows(w.company.id)).length, 1);
    assert.equal(JSON.stringify(outcome).includes('violates'), false);
  });

  it('regras da agenda: fora do expediente, domingo, passo, passado e antecedência mínima não encaixam', async () => {
    const w = await world('ai-rules');
    const ref = contact('13');
    for (const start of [
      slot(10, '22:00'), // fora do expediente
      slot(15, '09:00'), // domingo
      slot(10, '09:15'), // fora do passo de 30 min
      slot(9, '07:00'), // já passou
      slot(9, '09:00'), // 1 h à frente: menos que a antecedência de 2 h
      '2026-02-30T09:00', // data inexistente
    ]) {
      expectKind(await book(w, ref, start), 'outside_rules');
    }
    assert.equal((await rows(w.company.id)).length, 0);
    // Serviço desconhecido (ou de outra empresa): nada, com a lista dos nomes ativos.
    const unknown = expectKind(
      await ai.request(w.company.id, ref, {
        serviceName: 'Servico Inexistente',
        start: slot(10, '09:00'),
        customerLabel: null,
      }),
      'service_not_found',
    );
    assert.deepEqual(unknown.names, [w.serviceName]);
  });

  it('limites: 2 ativas por contato, 3 criações em 24 h (inclusive canceladas) e 30 PENDING por empresa', async () => {
    const w = await world('ai-limits');
    const ref = contact('14');
    expectKind(await book(w, ref, slot(10, '09:00')), 'booked');
    expectKind(await book(w, ref, slot(10, '09:30')), 'booked');
    const third = expectKind(await book(w, ref, slot(10, '10:00')), 'limit');
    assert.equal(third.reason, 'active');
    assert.equal(active(await rows(w.company.id, ref)).length, 2);

    // Criar e cancelar em ciclo: a 4ª criação em 24 h estoura, mesmo com poucas ativas.
    // `created_at` vem do relógio do banco: esta parte usa o relógio real (os horários seguem no futuro).
    const live = buildAi(quotaStore, () => new Date());
    const cycle = contact('15');
    const made = expectKind(
      await live.request(w.company.id, cycle, {
        serviceName: w.serviceName,
        customerLabel: null,
        start: slot(11, '09:00'),
      }),
      'booked',
    );
    assert.equal(made.already, false);
    const idOf = async () =>
      (await rows(w.company.id, cycle)).find((row) => row.status === 'PENDING')?.id ?? '';
    expectKind(await live.cancel(w.company.id, cycle, await idOf()), 'cancelled');
    expectKind(
      await live.request(w.company.id, cycle, {
        serviceName: w.serviceName,
        customerLabel: null,
        start: slot(11, '09:30'),
      }),
      'booked',
    );
    expectKind(await live.cancel(w.company.id, cycle, await idOf()), 'cancelled');
    expectKind(
      await live.request(w.company.id, cycle, {
        serviceName: w.serviceName,
        customerLabel: null,
        start: slot(11, '10:00'),
      }),
      'booked',
    );
    const fourth = expectKind(
      await live.request(w.company.id, cycle, {
        serviceName: w.serviceName,
        customerLabel: null,
        start: slot(11, '10:30'),
      }),
      'limit',
    );
    assert.equal(fourth.reason, 'creations');
    assert.equal((await rows(w.company.id, cycle)).length, 3);

    // 30 PENDING da IA ativos na empresa: o 31º devolve limite.
    const crowded = await world('ai-limits-pend');
    for (let index = 0; index < 30; index += 1) {
      const start = new Date(Date.UTC(2026, 11, 1, 12, 0) + index * 30 * 60_000);
      await appointments.create(crowded.company.id, {
        resourceId: crowded.resourceId,
        serviceId: crowded.serviceId,
        kind: 'BOOKING',
        status: 'PENDING',
        startsAt: start,
        endsAt: new Date(start.getTime() + 30 * 60_000),
        blockedUntil: new Date(start.getTime() + 30 * 60_000),
        customerLabel: null,
        contactRef: contact('16'),
        source: 'CHANNEL',
        createdByMembershipId: null,
      });
    }
    const last = expectKind(await book(crowded, contact('17'), slot(10, '09:00')), 'limit');
    assert.equal(last.reason, 'pending');
    assert.equal(active(await rows(crowded.company.id)).length, 30);
  });

  it('cotas no Redis: a 9ª escrita do contato recusa; Redis fora = indisponível, sem gravar', async () => {
    const w = await world('ai-quota');
    const ref = contact('18');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      expectKind(await ai.cancel(w.company.id, ref, randomUUID()), 'not_found');
    }
    const ninth = expectKind(await book(w, ref, slot(10, '09:00')), 'limit');
    assert.equal(ninth.reason, 'quota');
    assert.equal((await rows(w.company.id)).length, 0);

    const down: ScheduleAiQuotaStore = {
      ping: () => Promise.reject(new ServiceUnavailableError('fora')),
      take: () => Promise.reject(new ServiceUnavailableError('fora')),
    };
    const broken = buildAi(down);
    assert.equal(await broken.isAvailable(), false);
    expectKind(
      await broken.request(w.company.id, contact('19'), {
        serviceName: w.serviceName,
        start: slot(10, '09:00'),
        customerLabel: null,
      }),
      'unavailable',
    );
    assert.equal((await rows(w.company.id)).length, 0);
    assert.equal(await ai.isAvailable(), true);
  });
});

describe('isolamento entre empresas e entre contatos (E2/E3)', () => {
  it('o mesmo contactRef em duas empresas: A nunca lê nem altera dado da B', async () => {
    const a = await world('ai-iso-a', { serviceName: `Servico A ${SUFFIX}` });
    const b = await world('ai-iso-b', { serviceName: `Servico B ${SUFFIX}` });
    const ref = contact('20');
    expectKind(await book(a, ref, slot(10, '09:00')), 'booked');
    expectKind(await book(a, ref, slot(10, '09:30')), 'booked');
    // O contato é o mesmo, mas na B ele não tem nada: as cotas por contato valem por empresa.
    expectKind(await book(b, ref, slot(10, '09:00')), 'booked');
    const bRow = (await rows(b.company.id, ref))[0];
    assert.ok(bRow !== undefined);

    // Pela empresa A, o id da reserva da B (e o do contato) não é alcançável.
    expectKind(await ai.cancel(a.company.id, ref, bRow.id), 'not_found');
    expectKind(
      await ai.reschedule(a.company.id, ref, {
        appointmentId: bRow.id,
        newStart: slot(11, '09:00'),
      }),
      'not_found',
    );
    assert.equal((await rows(b.company.id, ref))[0]?.status, 'PENDING');
    // Serviço da B não é achado pelo nome na A.
    expectKind(
      await ai.request(a.company.id, ref, {
        serviceName: b.serviceName,
        start: slot(11, '09:00'),
        customerLabel: null,
      }),
      'service_not_found',
    );
    assert.equal(active(await rows(b.company.id)).length, 1);
  });

  it('o contato X nunca cancela nem remarca o que é do Y, do painel ou um bloqueio', async () => {
    const w = await world('ai-iso-c');
    const x = contact('21');
    const y = contact('22');
    expectKind(await book(w, y, slot(10, '09:00')), 'booked');
    const panel = await schedule.createAppointment(w.company.id, w.ownerId, {
      serviceId: w.serviceId,
      resourceId: w.resourceId,
      localStart: slot(10, '10:00'),
      status: 'CONFIRMED',
    });
    const [block] = await schedule.createBlocks(w.company.id, w.ownerId, {
      localStart: slot(10, '11:00'),
      localEnd: slot(10, '12:00'),
      resourceIds: [w.resourceId],
    });
    const yRow = (await rows(w.company.id, y))[0];
    assert.ok(yRow !== undefined && block !== undefined);
    for (const id of [yRow.id, panel.id, block.id]) {
      expectKind(await ai.cancel(w.company.id, x, id), 'not_found');
      expectKind(
        await ai.reschedule(w.company.id, x, { appointmentId: id, newStart: slot(11, '09:00') }),
        'not_found',
      );
    }
    assert.equal(active(await rows(w.company.id)).length, 3);
    assert.equal((await rows(w.company.id, y))[0]?.status, 'PENDING');
  });
});

describe('cancelar e remarcar (E3)', () => {
  it('cancelar é do contato e idempotente', async () => {
    const w = await world('ai-cancel');
    const ref = contact('23');
    expectKind(await book(w, ref, slot(10, '09:00')), 'booked');
    const id = (await rows(w.company.id, ref))[0]?.id ?? '';
    const first = expectKind(await ai.cancel(w.company.id, ref, id), 'cancelled');
    assert.equal(first.already, false);
    const again = expectKind(await ai.cancel(w.company.id, ref, id), 'cancelled');
    assert.equal(again.already, true);
    const row = (await rows(w.company.id, ref))[0];
    assert.equal(row?.status, 'CANCELLED');
    assert.equal(row.cancelledBy, 'CONTACT');
    // O horário foi liberado.
    expectKind(await book(w, contact('24'), slot(10, '09:00')), 'booked');
  });

  it('remarcar atômico: horário livre cancela o antigo e cria o novo; ocupado não muda nada', async () => {
    const w = await world('ai-resched');
    const ref = contact('25');
    expectKind(await book(w, ref, slot(10, '09:00'), 'Joana'), 'booked');
    const oldId = (await rows(w.company.id, ref))[0]?.id ?? '';

    const moved = expectKind(
      await ai.reschedule(w.company.id, ref, { appointmentId: oldId, newStart: slot(11, '10:00') }),
      'rescheduled',
    );
    assert.equal(moved.to.localStart, '10:00');
    const after = await rows(w.company.id, ref);
    assert.equal(after.length, 2);
    const oldRow = after.find((row) => row.id === oldId);
    assert.equal(oldRow?.status, 'CANCELLED');
    assert.equal(oldRow.cancelledBy, 'CONTACT');
    const fresh = after.find((row) => row.id !== oldId);
    assert.equal(fresh?.status, 'PENDING');
    assert.equal(fresh.customerLabel, 'Joana');
    assert.equal(fresh.contactRef, ref);

    // Destino ocupado por outro contato: nada muda e o antigo continua ativo.
    expectKind(await book(w, contact('26'), slot(12, '09:00')), 'booked');
    const newId = fresh.id;
    const refused = expectKind(
      await ai.reschedule(w.company.id, ref, { appointmentId: newId, newStart: slot(12, '09:00') }),
      'slot_taken',
    );
    assert.ok(refused.alternatives.length <= 3);
    const unchanged = await rows(w.company.id, ref);
    assert.equal(unchanged.length, 2);
    assert.equal(unchanged.find((row) => row.id === newId)?.status, 'PENDING');

    // Para um horário fora das regras: idem.
    expectKind(
      await ai.reschedule(w.company.id, ref, { appointmentId: newId, newStart: slot(12, '22:00') }),
      'outside_rules',
    );
    assert.equal(
      (await rows(w.company.id, ref)).find((row) => row.id === newId)?.status,
      'PENDING',
    );

    // Remarcar para um horário que se sobrepõe ao próprio antigo funciona (o antigo sai primeiro).
    expectKind(
      await ai.reschedule(w.company.id, ref, { appointmentId: newId, newStart: slot(11, '10:00') }),
      'rescheduled',
    );
  });

  it('remarcações concorrentes ao mesmo destino: um ganha, o outro continua com o antigo', async () => {
    const w = await world('ai-resched-race');
    const x = contact('27');
    const y = contact('28');
    expectKind(await book(w, x, slot(10, '09:00')), 'booked');
    expectKind(await book(w, y, slot(10, '09:30')), 'booked');
    const xId = (await rows(w.company.id, x))[0]?.id ?? '';
    const yId = (await rows(w.company.id, y))[0]?.id ?? '';
    const results = await Promise.all([
      ai.reschedule(w.company.id, x, { appointmentId: xId, newStart: slot(11, '11:00') }),
      ai.reschedule(w.company.id, y, { appointmentId: yId, newStart: slot(11, '11:00') }),
    ]);
    assert.deepEqual(results.map((outcome) => outcome.kind).toSorted(), [
      'rescheduled',
      'slot_taken',
    ]);
    const all = active(await rows(w.company.id));
    assert.equal(all.length, 2, 'cada contato continua com exatamente uma reserva ativa');
    assert.equal(
      all.filter((row) => row.startsAt.toISOString() === '2026-11-11T14:00:00.000Z').length,
      1,
    );
  });
});

describe('interruptores da IA na configuração da agenda (E2/E4)', () => {
  it('padrão desligado; auto-confirmar exige a IA ligada; desligar a IA desliga a confirmação; o banco recusa o resto', async () => {
    const company = await tenants.createCompany('ai-settings');
    const initial = await schedule.getSettings(company.id);
    assert.equal(initial.aiBookingEnabled, false);
    assert.equal(initial.aiAutoConfirm, false);
    const base = {
      timezone: initial.timezone,
      slotStepMinutes: 30,
      minNoticeMinutes: 120,
      maxAdvanceDays: 60,
    };
    await assert.rejects(
      schedule.updateSettings(company.id, { ...base, aiAutoConfirm: true }),
      (error: unknown) => (error as { code?: string }).code === 'INVALID_AI_SETTINGS',
    );
    const on = await schedule.updateSettings(company.id, {
      ...base,
      aiBookingEnabled: true,
      aiAutoConfirm: true,
    });
    assert.equal(on.aiBookingEnabled && on.aiAutoConfirm, true);
    // Omitidos = não mudam.
    const same = await schedule.updateSettings(company.id, { ...base, minNoticeMinutes: 60 });
    assert.equal(same.aiBookingEnabled && same.aiAutoConfirm, true);
    const off = await schedule.updateSettings(company.id, { ...base, aiBookingEnabled: false });
    assert.equal(off.aiBookingEnabled, false);
    assert.equal(off.aiAutoConfirm, false, 'desligar a IA desliga a confirmação automática');
  });
});
