import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { AttendanceService } from '../../application/attendance/attendance.service.js';
import { ScheduleService } from '../../application/schedule/schedule.service.js';
import type { Company } from '../../domain/index.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { captureLogs, logContains } from '../../test-support/log-capture.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import { MockLlmProvider } from '../external-apis/llm/mock-llm.provider.js';
import { createLogger } from '../logger/logger.js';
import { createMetrics } from '../metrics/index.js';
import { createDatabase, type Database } from './database.js';
import { PrismaAttendanceUnitOfWork } from './repositories/attendance-unit-of-work.js';
import { PrismaCompanyRepository } from './repositories/company.repository.js';
import { PrismaConversationRepository } from './repositories/conversation.repository.js';
import { PrismaMembershipRepository } from './repositories/membership.repository.js';
import { PrismaMessageRepository } from './repositories/message.repository.js';
import { PrismaScheduleAvailabilityReader } from './repositories/schedule-availability-reader.js';
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
const SUFFIX = randomBytes(4).toString('hex');
const SERVICE_A = `Servico A ${SUFFIX}`;
const SERVICE_B = `Servico B ${SUFFIX}`;
// O mesmo contato nas duas empresas (a chave do isolamento é empresa + contato).
const CONTACT = `5511${SUFFIX.replace(/\D/g, '').padEnd(8, '7').slice(0, 8)}`;
const OTHER_CONTACT = '5511000000001';

let database: Database;
let tenants: TestTenants;
let reader: PrismaScheduleAvailabilityReader;
let appointments: PrismaAppointmentRepository;
let schedule: ScheduleService;
let companyA: Company;
let companyB: Company;
const serviceIds: Record<string, string> = {};
const resourceIds: Record<string, string> = {};
const ownerIds: Record<string, string> = {};
const HASH = 'scrypt$1024$8$1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA==';
const logs = captureLogs();

const at = (iso: string): Date => new Date(iso);

before(async () => {
  database = createDatabase(config, createLogger(config));
  tenants = new TestTenants(database.prisma);
  reader = new PrismaScheduleAvailabilityReader(database.prisma, () => NOW);
  appointments = new PrismaAppointmentRepository(database.prisma);
  schedule = new ScheduleService({
    settings: new PrismaScheduleSettingsRepository(database.prisma),
    resources: new PrismaScheduleResourceRepository(database.prisma),
    services: new PrismaScheduleServiceRepository(database.prisma),
    rules: new PrismaAvailabilityRuleRepository(database.prisma),
    appointments,
    logger: logs.logger,
    now: () => NOW,
  });
  companyA = await tenants.createCompany('tl-a');
  companyB = await tenants.createCompany('tl-b');
  const memberships = new PrismaMembershipRepository(database.prisma);
  for (const [key, company, name] of [
    ['A', companyA, SERVICE_A],
    ['B', companyB, SERVICE_B],
  ] as const) {
    ownerIds[key] = (
      await memberships.create(company.id, {
        email: `${key.toLowerCase()}-${SUFFIX}@exemplo.test`,
        passwordHash: HASH,
        role: 'OWNER',
      })
    ).id;
    const [main] = await schedule.listResources(company.id);
    assert.ok(main !== undefined);
    resourceIds[key] = main.id;
    const created = await schedule.createService(company.id, {
      name,
      durationMinutes: 30,
      bufferMinutes: 0,
    });
    serviceIds[key] = created.id;
    // Terça a sexta, das 09:00 às 10:00 (2 horários por dia para 30 min).
    await schedule.setRules(
      company.id,
      main.id,
      [2, 3, 4, 5].map((weekday) => ({ weekday, start: 540, end: 600 })),
    );
  }
});

after(async () => {
  try {
    await tenants.cleanup();
  } finally {
    await database.close();
  }
});

async function book(
  company: Company,
  key: 'A' | 'B',
  startsAt: string,
  extra: {
    contactRef?: string | null;
    status?: 'PENDING' | 'CONFIRMED';
    kind?: 'BOOKING' | 'BLOCK';
    serviceKey?: 'A' | 'B' | null;
  } = {},
) {
  const start = at(startsAt);
  const end = new Date(start.getTime() + 30 * 60_000);
  return appointments.create(company.id, {
    resourceId: resourceIds[key] ?? '',
    serviceId: extra.serviceKey === null ? null : (serviceIds[extra.serviceKey ?? key] ?? null),
    kind: extra.kind ?? 'BOOKING',
    status: extra.status ?? 'PENDING',
    startsAt: start,
    endsAt: end,
    blockedUntil: end,
    customerLabel: null,
    contactRef: extra.kind === 'BLOCK' ? null : (extra.contactRef ?? null),
    source: extra.contactRef === undefined || extra.contactRef === null ? 'PANEL' : 'CHANNEL',
    // O banco exige: origem PANEL tem quem criou; origem CHANNEL não.
    createdByMembershipId:
      extra.contactRef === undefined || extra.contactRef === null ? (ownerIds[key] ?? null) : null,
  });
}

describe('readContactAppointments: isolamento por empresa e por contato (spec 028)', () => {
  before(async () => {
    // Contato de A: dois futuros ativos (um confirmado), um passado, um cancelado, um sem serviço.
    await book(companyA, 'A', '2026-11-10T17:00:00.000Z', { contactRef: CONTACT });
    await book(companyA, 'A', '2026-11-11T17:00:00.000Z', {
      contactRef: CONTACT,
      status: 'CONFIRMED',
    });
    await book(companyA, 'A', '2026-11-06T17:00:00.000Z', { contactRef: CONTACT });
    const cancelled = await book(companyA, 'A', '2026-11-12T17:00:00.000Z', {
      contactRef: CONTACT,
    });
    await appointments.transition(companyA.id, cancelled.id, {
      from: 'PENDING',
      to: 'CANCELLED',
      cancelledBy: 'CONTACT',
      now: NOW,
    });
    // Outro contato da A, o painel (sem contato) e um bloqueio.
    await book(companyA, 'A', '2026-11-13T17:00:00.000Z', { contactRef: OTHER_CONTACT });
    await book(companyA, 'A', '2026-11-12T19:00:00.000Z', { contactRef: null });
    await book(companyA, 'A', '2026-11-12T20:00:00.000Z', { kind: 'BLOCK', serviceKey: null });
    // O MESMO contactRef na empresa B.
    await book(companyB, 'B', '2026-11-10T18:00:00.000Z', { contactRef: CONTACT });
  });

  it('devolve só os ativos e futuros do contato, mais próximos primeiro, só nome, data, hora e estado', async () => {
    const list = await reader.readContactAppointments(companyA.id, CONTACT, 3);
    assert.deepEqual(
      list.map((item) => ({
        serviceName: item.serviceName,
        localDate: item.localDate,
        localStart: item.localStart,
        status: item.status,
      })),
      [
        { serviceName: SERVICE_A, localDate: '2026-11-10', localStart: '14:00', status: 'PENDING' },
        {
          serviceName: SERVICE_A,
          localDate: '2026-11-11',
          localStart: '14:00',
          status: 'CONFIRMED',
        },
      ],
    );
    for (const item of list) {
      assert.deepEqual(Object.keys(item).sort(), [
        'id',
        'localDate',
        'localStart',
        'serviceName',
        'status',
      ]);
    }
  });

  it('a empresa B, com o mesmo contactRef, só enxerga o que é dela (e a A não vê o da B)', async () => {
    const forB = await reader.readContactAppointments(companyB.id, CONTACT, 3);
    assert.deepEqual(
      forB.map((item) => ({
        serviceName: item.serviceName,
        localDate: item.localDate,
        localStart: item.localStart,
        status: item.status,
      })),
      [{ serviceName: SERVICE_B, localDate: '2026-11-10', localStart: '15:00', status: 'PENDING' }],
    );
    const forA = await reader.readContactAppointments(companyA.id, CONTACT, 3);
    assert.ok(forA.every((item) => item.serviceName === SERVICE_A));
  });

  it('outro contato não vê os agendamentos deste; contato sem nada recebe lista vazia', async () => {
    const other = await reader.readContactAppointments(companyA.id, OTHER_CONTACT, 3);
    assert.equal(other.length, 1);
    assert.equal(other[0]?.localDate, '2026-11-13');
    assert.deepEqual(await reader.readContactAppointments(companyA.id, 'ninguem', 3), []);
  });

  it('respeita o limite pedido', async () => {
    const list = await reader.readContactAppointments(companyA.id, CONTACT, 1);
    assert.equal(list.length, 1);
  });
});

describe('read com período: o que listar_horarios usa (spec 028)', () => {
  it('sem período: hoje até 6 dias depois (como na 027)', async () => {
    const result = await reader.read(companyA.id);
    const days = new Set(result.services[0]?.slots.map((slot) => slot.localDate));
    assert.deepEqual([...days].sort(), ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']);
  });

  it('o período pedido limita os dias; início antes de hoje vira hoje; fim passa de 7 dias é cortado', async () => {
    const narrow = await reader.read(companyA.id, { fromDate: '2026-11-11', toDate: '2026-11-12' });
    assert.deepEqual([...new Set(narrow.services[0]?.slots.map((slot) => slot.localDate))].sort(), [
      '2026-11-11',
      '2026-11-12',
    ]);
    const past = await reader.read(companyA.id, { fromDate: '2026-01-01', toDate: '2026-01-05' });
    assert.deepEqual(past.services[0]?.slots, [], 'todo o período já passou');
    const clipped = await reader.read(companyA.id, {
      fromDate: '2026-11-10',
      toDate: '2026-12-31',
    });
    const dates = [...new Set(clipped.services[0]?.slots.map((slot) => slot.localDate))].sort();
    assert.ok(dates.every((date) => date <= '2026-11-16'));
    const onlyEnd = await reader.read(companyA.id, { toDate: '2026-11-10' });
    assert.deepEqual(
      [...new Set(onlyEnd.services[0]?.slots.map((slot) => slot.localDate))],
      ['2026-11-10'],
    );
  });

  it('só lê serviços da empresa do pedido', async () => {
    const forA = await reader.read(companyA.id, { fromDate: '2026-11-10', toDate: '2026-11-12' });
    const forB = await reader.read(companyB.id, { fromDate: '2026-11-10', toDate: '2026-11-12' });
    assert.deepEqual(
      forA.services.map((service) => service.name),
      [SERVICE_A],
    );
    assert.deepEqual(
      forB.services.map((service) => service.name),
      [SERVICE_B],
    );
  });

  it('horário já reservado (ativo) sai da lista; o do contato cancelado volta', async () => {
    const result = await reader.read(companyA.id, { fromDate: '2026-11-10', toDate: '2026-11-10' });
    // 14:00 está ocupado, mas as janelas são 09:00 e 09:30: usa um dia sem reserva e confirma 09:00.
    assert.deepEqual(result.services[0]?.slots, [
      { localDate: '2026-11-10', localStart: '09:00' },
      { localDate: '2026-11-10', localStart: '09:30' },
    ]);
    await book(companyA, 'A', '2026-11-10T12:00:00.000Z', { contactRef: OTHER_CONTACT });
    const after = await reader.read(companyA.id, { fromDate: '2026-11-10', toDate: '2026-11-10' });
    assert.deepEqual(after.services[0]?.slots, [{ localDate: '2026-11-10', localStart: '09:30' }]);
  });
});

describe('turno completo com ferramenta, contra o PostgreSQL (spec 028, E1)', () => {
  it('o mock roteirizado consulta pela ferramenta, só da própria empresa, sem vazar nada em log', async () => {
    const llm = new MockLlmProvider({ recordCalls: true });
    const service = new AttendanceService({
      companies: new PrismaCompanyRepository(database.prisma),
      conversations: new PrismaConversationRepository(database.prisma),
      messages: new PrismaMessageRepository(database.prisma),
      unitOfWork: new PrismaAttendanceUnitOfWork(database.prisma),
      llm,
      logger: logs.logger,
      metrics: createMetrics(),
      options: { llmTimeoutMs: 2_000, inFlightTimeoutMs: 60_000, scheduleAiEnabled: true },
      schedule: reader,
    });
    // Pelo canal (contato real): o `respondToPending` oferece as ferramentas e a lista do contato.
    const viaChannel = async (company: Company, externalId: string): Promise<string> => {
      await service.acceptInboundMessage(company.id, {
        contactRef: CONTACT,
        text: 'quero marcar um horário',
        externalId,
      });
      const response = await service.respondToPending(company.id, CONTACT, {
        maxMessages: 10,
        maxChars: 8_000,
      });
      return response.reply?.text ?? '';
    };
    const script = {
      rounds: [
        [{ name: 'listar_horarios', input: { servico: SERVICE_A } }],
        [{ name: 'listar_horarios', input: { servico: SERVICE_B } }],
      ],
      finalText: (outputs: readonly { content: string }[]) =>
        outputs.map((output) => output.content.split('.')[0]).join(' | '),
    };
    llm.scriptTools(script);
    const asA = await viaChannel(companyA, 'a1');
    // A vê o próprio serviço; o da B não existe para ela.
    assert.ok(asA.startsWith(`ok: ${SERVICE_A} (30 min)`), asA);
    assert.ok(asA.includes('servico_nao_encontrado: servicos ativos: Servico A'));
    assert.equal(asA.includes(SERVICE_B), false);
    // O prompt traz a lista do contato da A (só dele) e nada do telefone.
    const prompt = llm.calls[0]?.systemPrompt ?? '';
    assert.ok(prompt.includes('<meus_agendamentos>'));
    assert.ok(prompt.includes(`[1] ${SERVICE_A}, ter 10/11 14:00, aguardando confirmação`));
    assert.equal(prompt.includes(SERVICE_B), false);
    assert.equal(prompt.includes(CONTACT), false);

    llm.scriptTools(script);
    const asB = await viaChannel(companyB, 'b1');
    assert.ok(asB.startsWith('servico_nao_encontrado: servicos ativos: Servico B'));
    assert.ok(asB.includes(`ok: ${SERVICE_B} (30 min)`));
    const promptB = llm.calls[1]?.systemPrompt ?? '';
    assert.ok(promptB.includes(`[1] ${SERVICE_B}, ter 10/11 15:00, aguardando confirmação`));
    assert.equal(promptB.includes(SERVICE_A), false);

    const raw = logs.raw();
    for (const secret of [SERVICE_A, SERVICE_B, CONTACT, '14:00', '2026-11-10']) {
      assert.equal(logContains(raw, secret), false, `vazou em log: ${secret}`);
    }
  });
});
