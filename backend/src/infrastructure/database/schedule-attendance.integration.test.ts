import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  AttendanceService,
  buildSystemPrompt,
} from '../../application/attendance/attendance.service.js';
import { ScheduleService } from '../../application/schedule/schedule.service.js';
import type { Company, Membership } from '../../domain/index.js';
import { captureLogs, logContains } from '../../test-support/log-capture.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
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
const HASH = 'scrypt$1024$8$1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA==';
// Segunda-feira 2026-11-09, 08:00 em São Paulo: a janela de 7 dias vai até domingo 2026-11-15.
const NOW = new Date('2026-11-09T11:00:00.000Z');
const SECRET_SERVICE = `Servico secreto ${randomBytes(5).toString('hex')}`;
const SECRET_LABEL = `Pessoa secreta ${randomBytes(5).toString('hex')}`;
const BATCH = { maxMessages: 10, maxChars: 8_000 };

let database: Database;
let tenants: TestTenants;
let service: AttendanceService;
let llm: MockLlmProvider;
let schedule: ScheduleService;
let companyA: Company;
let companyB: Company;
let ownerA: Membership;
let serviceId = '';
const logs = captureLogs();
const metrics = createMetrics();

before(async () => {
  database = createDatabase(config, createLogger(config));
  tenants = new TestTenants(database.prisma);
  llm = new MockLlmProvider({ recordCalls: true });
  service = new AttendanceService({
    companies: new PrismaCompanyRepository(database.prisma),
    conversations: new PrismaConversationRepository(database.prisma),
    messages: new PrismaMessageRepository(database.prisma),
    unitOfWork: new PrismaAttendanceUnitOfWork(database.prisma),
    llm,
    logger: logs.logger,
    metrics,
    options: { llmTimeoutMs: 2_000, inFlightTimeoutMs: 60_000 },
    schedule: new PrismaScheduleAvailabilityReader(database.prisma, () => NOW),
  });
  schedule = new ScheduleService({
    settings: new PrismaScheduleSettingsRepository(database.prisma),
    resources: new PrismaScheduleResourceRepository(database.prisma),
    services: new PrismaScheduleServiceRepository(database.prisma),
    rules: new PrismaAvailabilityRuleRepository(database.prisma),
    appointments: new PrismaAppointmentRepository(database.prisma),
    logger: logs.logger,
    now: () => NOW,
  });
  const memberships = new PrismaMembershipRepository(database.prisma);
  companyA = await tenants.createCompany('sa-a');
  companyB = await tenants.createCompany('sa-b');
  ownerA = await memberships.create(companyA.id, {
    email: `a-${randomBytes(4).toString('hex')}@exemplo.test`,
    passwordHash: HASH,
    role: 'OWNER',
  });
  const [main] = await schedule.listResources(companyA.id);
  assert.ok(main !== undefined);
  const created = await schedule.createService(companyA.id, {
    name: SECRET_SERVICE,
    durationMinutes: 30,
    bufferMinutes: 0,
  });
  serviceId = created.id;
  // Terça e quarta, das 09:00 às 11:00 (4 horários por dia para 30 min).
  await schedule.setRules(companyA.id, main.id, [
    { weekday: 2, start: 540, end: 660 },
    { weekday: 3, start: 540, end: 660 },
  ]);
});

after(async () => {
  try {
    await tenants.cleanup();
  } finally {
    await database.close();
  }
});

/** Linhas `[Serviço] ...` do bloco no último prompt enviado ao modelo para esta mensagem. */
function scheduleLine(userMessage: string): string | undefined {
  const call = llm.calls.findLast((entry) => entry.userMessage === userMessage);
  return call?.systemPrompt.split('\n').find((line) => line.startsWith('[Serviço] '));
}

describe('atendimento com agenda, contra o PostgreSQL (spec 027, E3)', () => {
  it('simulador: a resposta do mock conta o serviço e a fonte é só o rótulo fixo', async () => {
    const text = 'tem horário amanhã?';
    const result = await service.handleInboundMessage(companyA.id, { contactRef: 'sa-sim', text });
    assert.match(result.reply.text, /\(agenda: 1 serviços\)$/);
    assert.deepEqual(result.sources, [{ kind: 'schedule', label: 'Agenda: horários livres' }]);
    const serialized = JSON.stringify(result.sources);
    assert.equal(serialized.includes(SECRET_SERVICE), false);
    assert.equal(/\d{2}:\d{2}/.test(serialized), false);
    // O texto do contato só em userMessage.
    const call = llm.calls.findLast((entry) => entry.userMessage === text);
    assert.ok(call !== undefined);
    assert.equal(call.systemPrompt.includes(text), false);
    assert.ok(call.systemPrompt.includes(SECRET_SERVICE));
  });

  it('os horários do prompt batem com a API de disponibilidade no mesmo "agora"', async () => {
    const text = 'quero agendar uma data';
    await service.handleInboundMessage(companyA.id, { contactRef: 'sa-match', text });
    const line = scheduleLine(text);
    assert.ok(line !== undefined);
    const api = await schedule.availability(companyA.id, {
      serviceId,
      from: '2026-11-09',
      to: '2026-11-15',
    });
    // O prompt mostra os 6 mais próximos, agrupados por dia: terça 4 horários e quarta 2.
    const expected = api.slots.slice(0, 6).map((slot) => `${slot.localDate} ${slot.localStart}`);
    assert.deepEqual(expected, [
      '2026-11-10 09:00',
      '2026-11-10 09:30',
      '2026-11-10 10:00',
      '2026-11-10 10:30',
      '2026-11-11 09:00',
      '2026-11-11 09:30',
    ]);
    assert.ok(line.includes('ter 10/11 09:00, 09:30, 10:00, 10:30; qua 11/11 09:00, 09:30'), line);
  });

  it('horário reservado pelo painel sai do bloco da próxima pergunta', async () => {
    const [main] = await schedule.listResources(companyA.id);
    assert.ok(main !== undefined);
    await schedule.createAppointment(companyA.id, ownerA.id, {
      serviceId,
      resourceId: main.id,
      localStart: '2026-11-10T09:00',
      customerLabel: SECRET_LABEL,
    });
    const text = 'sobrou horário para agendar?';
    await service.handleInboundMessage(companyA.id, { contactRef: 'sa-taken', text });
    const line = scheduleLine(text) ?? '';
    assert.ok(line.includes('ter 10/11 09:30, 10:00, 10:30'), line);
    assert.equal(line.includes('ter 10/11 09:00'), false);
    // Nada de quem reservou vai ao modelo.
    const call = llm.calls.findLast((entry) => entry.userMessage === text);
    assert.equal(call?.systemPrompt.includes(SECRET_LABEL), false);
  });

  it('lote do canal (respondToPending) também consulta', async () => {
    await service.acceptInboundMessage(companyA.id, {
      contactRef: 'sa-canal',
      text: 'consulta amanhã?',
    });
    const response = await service.respondToPending(companyA.id, 'sa-canal', BATCH);
    assert.equal(response.outcome, 'answered');
    assert.match(response.reply?.text ?? '', /\(agenda: 1 serviços\)$/);
  });

  it('a outra empresa, com a mesma pergunta, não recebe nada da A e o prompt é idêntico ao de hoje', async () => {
    const text = 'tem horário amanhã?';
    const result = await service.handleInboundMessage(companyB.id, { contactRef: 'sa-b', text });
    assert.deepEqual(result.sources, []);
    assert.equal(result.reply.text.includes('(agenda:'), false);
    const call = llm.calls.findLast((entry) => entry.userMessage === text);
    assert.equal(call?.systemPrompt.includes(SECRET_SERVICE), false);
    assert.equal(call.systemPrompt, buildSystemPrompt(companyB));
  });

  it('sem intenção: o prompt da empresa com agenda é idêntico ao de hoje', async () => {
    const text = 'obrigado, até logo';
    await service.handleInboundMessage(companyA.id, { contactRef: 'sa-none', text });
    const call = llm.calls.findLast((entry) => entry.userMessage === text);
    assert.equal(call?.systemPrompt, buildSystemPrompt(companyA));
  });

  it('serviço desativado não é oferecido; sem nenhum serviço ativo o prompt não muda', async () => {
    const solo = await tenants.createCompany('sa-solo');
    const created = await schedule.createService(solo.id, {
      name: 'Serviço temporário',
      durationMinutes: 30,
      bufferMinutes: 0,
    });
    const text = 'quero agendar';
    await service.handleInboundMessage(solo.id, { contactRef: 'sa-solo', text });
    assert.match(
      llm.calls.findLast((entry) => entry.userMessage === text)?.systemPrompt ?? '',
      /Sem horários livres nos próximos 7 dias para este serviço/,
    );
    await schedule.updateService(solo.id, created.id, { active: false });
    const again = 'quero marcar de novo';
    await service.handleInboundMessage(solo.id, { contactRef: 'sa-solo2', text: again });
    assert.equal(
      llm.calls.findLast((entry) => entry.userMessage === again)?.systemPrompt,
      buildSystemPrompt(solo),
    );
  });

  it('nome de serviço, rótulo, contato e horários não aparecem em nenhum log do atendimento', () => {
    const raw = logs.raw();
    for (const secret of [SECRET_SERVICE, SECRET_LABEL, '09:30', '2026-11-10', 'ter 10/11']) {
      assert.equal(logContains(raw, secret), false, `vazou em log: ${secret}`);
    }
    assert.ok(
      logs
        .lines()
        .some(
          (line) =>
            line['msg'] === 'mensagem atendida' && typeof line['scheduleServices'] === 'number',
        ),
    );
  });
});

describe('leitura da agenda com prazo no banco (spec 027, sugestão da revisão)', () => {
  it('a leitura roda numa transação com statement_timeout local definido uma vez', async () => {
    const statements: string[] = [];
    const spied = Object.create(database.prisma) as typeof database.prisma;
    const original = database.prisma.$transaction.bind(database.prisma) as (
      fn: (tx: Record<string, unknown>) => Promise<unknown>,
      options?: unknown,
    ) => Promise<unknown>;
    (spied as unknown as { $transaction: unknown }).$transaction = (
      fn: (tx: Record<string, unknown>) => Promise<unknown>,
      options?: unknown,
    ) =>
      original((tx) => {
        const raw = tx['$executeRaw'] as (...args: unknown[]) => unknown;
        const wrapped = Object.create(tx) as Record<string, unknown>;
        wrapped['$executeRaw'] = (strings: TemplateStringsArray, ...values: unknown[]) => {
          statements.push(`${strings.join('?')}|${values.map(String).join(',')}`);
          return raw.call(tx, strings, ...values);
        };
        return fn(wrapped);
      }, options);
    const reader = new PrismaScheduleAvailabilityReader(spied, () => NOW, 1_500);
    const result = await reader.read(companyA.id);
    assert.equal(result.hasSchedule, true);
    assert.equal(statements.length, 1);
    assert.match(statements[0] ?? '', /set_config\('statement_timeout'.*\|1500/);
  });
});
