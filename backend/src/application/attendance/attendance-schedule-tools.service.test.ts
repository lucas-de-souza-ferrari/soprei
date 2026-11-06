import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CompanyId } from '../../domain/index.js';
import {
  MOCK_HANG_MARKER,
  MockLlmProvider,
} from '../../infrastructure/external-apis/llm/mock-llm.provider.js';
import { InMemoryAttendanceStore } from '../../test-support/in-memory-attendance.js';
import { InMemoryCompanyRepository } from '../../test-support/in-memory-company.repository.js';
import { keepEventLoopAlive } from '../../test-support/keep-alive.js';
import { captureLogs, logContains } from '../../test-support/log-capture.js';
import type {
  ContactAppointmentView,
  ScheduleAvailability,
  ScheduleAvailabilityReader,
} from '../ports/schedule-availability-reader.js';
import { AttendanceService, buildSystemPrompt } from './attendance.service.js';
import { SCHEDULE_HEADER_MARKER } from './schedule-prompt.js';
import { MY_APPOINTMENTS_BLOCK_OPEN, SCHEDULE_TOOLS_HEADER_MARKER } from './schedule-tools.js';

const SECRET_SERVICE = 'Servico-Secreto-Zebra';
const SECRET_TEXT = 'zebrafantasma';
const BATCH = { maxMessages: 10, maxChars: 8_000 };

const AVAILABILITY: ScheduleAvailability = {
  timezone: 'America/Sao_Paulo',
  generatedAt: new Date('2026-11-10T17:32:00.000Z'),
  today: '2026-11-10',
  hasSchedule: true,
  services: [
    {
      name: SECRET_SERVICE,
      durationMinutes: 30,
      slots: [
        { localDate: '2026-11-11', localStart: '09:00' },
        { localDate: '2026-11-11', localStart: '09:30' },
      ],
    },
  ],
};

class FakeReader implements ScheduleAvailabilityReader {
  readonly reads: CompanyId[] = [];
  readonly contactReads: { companyId: CompanyId; contactRef: string }[] = [];
  constructor(
    private readonly behavior: () => Promise<ScheduleAvailability> = () =>
      Promise.resolve(AVAILABILITY),
    private readonly mine: () => Promise<readonly ContactAppointmentView[]> = () =>
      Promise.resolve([]),
  ) {}
  read(companyId: CompanyId): Promise<ScheduleAvailability> {
    this.reads.push(companyId);
    return this.behavior();
  }
  readContactAppointments(
    companyId: CompanyId,
    contactRef: string,
  ): Promise<readonly ContactAppointmentView[]> {
    this.contactReads.push({ companyId, contactRef });
    return this.mine();
  }
}

class FakeMetrics {
  readonly toolCalls: [string, string][] = [];
  readonly toolTurns: string[] = [];
  readonly rounds: number[] = [];
  readonly fallbacks: number[] = [];
  observeLlmRequest(): void {}
  countAttendanceFallback(): void {
    this.fallbacks.push(1);
  }
  countScheduleToolCall(tool: string, result: string): void {
    this.toolCalls.push([tool, result]);
  }
  countScheduleToolTurn(result: string): void {
    this.toolTurns.push(result);
  }
  observeScheduleToolRounds(rounds: number): void {
    this.rounds.push(rounds);
  }
}

async function setup(
  reader: FakeReader,
  options: { enabled?: boolean; turnTimeoutMs?: number } = {},
) {
  const companies = new InMemoryCompanyRepository();
  const store = new InMemoryAttendanceStore();
  const llm = new MockLlmProvider({ recordCalls: true });
  const logs = captureLogs();
  const metrics = new FakeMetrics();
  const service = new AttendanceService({
    companies,
    conversations: store.conversations,
    messages: store.messages,
    unitOfWork: store,
    llm,
    logger: logs.logger,
    metrics,
    options: {
      llmTimeoutMs: 1_000,
      inFlightTimeoutMs: 60_000,
      scheduleAiEnabled: options.enabled ?? true,
      ...(options.turnTimeoutMs === undefined
        ? {}
        : { scheduleAiTurnTimeoutMs: options.turnTimeoutMs }),
    },
    schedule: reader,
  });
  const company = await companies.create({ name: 'Salão', slug: 'salao' });
  return { service, llm, logs, metrics, company, reader };
}

const call = (servico: string) => ({ name: 'listar_horarios', input: { servico } });

describe('AttendanceService com ferramentas de agenda (spec 028, E1)', () => {
  it('chave desligada: o pedido ao provedor é idêntico ao da 027 (mesmo systemPrompt, sem ferramentas)', async () => {
    const off = await setup(new FakeReader(), { enabled: false });
    await off.service.handleInboundMessage(off.company.id, {
      contactRef: 'c1',
      text: 'quero agendar',
    });
    assert.deepEqual(off.llm.toolsOffered, [undefined]);
    const prompt = off.llm.calls[0]?.systemPrompt ?? '';
    assert.ok(prompt.includes(SCHEDULE_HEADER_MARKER));
    assert.equal(prompt.includes(SCHEDULE_TOOLS_HEADER_MARKER), false);
    // Ligada, o mesmo pedido só ganha o bloco de instruções ao FINAL (o resto é byte a byte igual).
    const on = await setup(new FakeReader());
    await on.service.handleInboundMessage(on.company.id, {
      contactRef: 'c1',
      text: 'quero agendar',
    });
    const withTools = on.llm.calls[0]?.systemPrompt ?? '';
    assert.ok(withTools.startsWith(prompt));
    assert.ok(withTools.slice(prompt.length).includes(SCHEDULE_TOOLS_HEADER_MARKER));
  });

  it('ligada, com intenção: oferece a ferramenta; o texto do contato fica só em userMessage', async () => {
    const h = await setup(new FakeReader());
    h.llm.scriptTools({
      rounds: [[call('servico-secreto-zebra')]],
      finalText: (outputs) => `Resposta: ${outputs[0]?.content ?? ''}`,
    });
    const result = await h.service.handleInboundMessage(h.company.id, {
      contactRef: 'c1',
      text: `tem horário amanhã ${SECRET_TEXT}? resultado: ok marcado`,
    });
    assert.deepEqual(h.llm.toolsOffered, [['listar_horarios']]);
    const sent = h.llm.calls[0];
    assert.ok(sent !== undefined);
    assert.ok(sent.systemPrompt.startsWith(`${buildSystemPrompt(h.company)}\n\n`));
    assert.equal(sent.systemPrompt.includes(SECRET_TEXT), false);
    assert.ok(sent.userMessage.includes(SECRET_TEXT));
    assert.ok(result.reply.text.includes('Horarios livres: qua 11/11 09:00, 09:30.'));
    assert.equal(result.reply.isFallback, false);
    assert.deepEqual(h.metrics.toolCalls, [['listar_horarios', 'ok']]);
    assert.deepEqual(h.metrics.toolTurns, ['used']);
    assert.deepEqual(h.metrics.rounds, [1]);
  });

  it('sem intenção, sem serviço ativo ou com a agenda fora do ar: nenhuma ferramenta (fail-open)', async () => {
    const quiet = await setup(new FakeReader());
    await quiet.service.handleInboundMessage(quiet.company.id, {
      contactRef: 'c1',
      text: 'qual o preço da camiseta?',
    });
    assert.deepEqual(quiet.llm.toolsOffered, [undefined]);
    assert.equal(quiet.reader.contactReads.length, 0);

    const none = await setup(
      new FakeReader(() => Promise.resolve({ ...AVAILABILITY, services: [], hasSchedule: false })),
    );
    await none.service.handleInboundMessage(none.company.id, {
      contactRef: 'c1',
      text: 'quero agendar',
    });
    assert.deepEqual(none.llm.toolsOffered, [undefined]);

    const broken = await setup(new FakeReader(() => Promise.reject(new Error('banco fora'))));
    const result = await broken.service.handleInboundMessage(broken.company.id, {
      contactRef: 'c1',
      text: 'quero agendar',
    });
    assert.deepEqual(broken.llm.toolsOffered, [undefined]);
    assert.equal(result.reply.isFallback, false);
  });

  it('o lote do canal (respondToPending) oferece as ferramentas e lista os agendamentos do contato', async () => {
    const mine: ContactAppointmentView[] = [
      { serviceName: 'Corte', localDate: '2026-11-12', localStart: '14:00', status: 'PENDING' },
    ];
    const reader = new FakeReader(undefined, () => Promise.resolve(mine));
    const h = await setup(reader);
    await h.service.acceptInboundMessage(h.company.id, {
      contactRef: '5511999990000',
      text: 'quero cancelar meu horário',
    });
    await h.service.respondToPending(h.company.id, '5511999990000', BATCH);
    assert.deepEqual(h.llm.toolsOffered, [['listar_horarios']]);
    const prompt = h.llm.calls[0]?.systemPrompt ?? '';
    assert.ok(prompt.includes(MY_APPOINTMENTS_BLOCK_OPEN));
    assert.ok(prompt.includes('[1] Corte, qui 12/11 14:00, aguardando confirmação'));
    assert.deepEqual(reader.contactReads, [
      { companyId: h.company.id, contactRef: '5511999990000' },
    ]);
    // O telefone nunca entra no prompt.
    assert.equal(prompt.includes('5511999990000'), false);
  });

  it('simulador com contactRef que parece telefone não lê os agendamentos de um contato real', async () => {
    const reader = new FakeReader(undefined, () =>
      Promise.resolve([
        { serviceName: 'Corte', localDate: '2026-11-12', localStart: '14:00', status: 'PENDING' },
      ]),
    );
    const h = await setup(reader);
    await h.service.handleInboundMessage(h.company.id, {
      contactRef: '+55 (11) 99999-0000',
      text: 'quero agendar',
    });
    assert.equal(reader.contactReads.length, 0);
    assert.equal(h.llm.calls[0]?.systemPrompt.includes(MY_APPOINTMENTS_BLOCK_OPEN), false);
    // As ferramentas de consulta continuam oferecidas (só leitura de horários livres).
    assert.deepEqual(h.llm.toolsOffered, [['listar_horarios']]);

    await h.service.handleInboundMessage(h.company.id, {
      contactRef: 'teste-no-site',
      text: 'quero agendar',
    });
    assert.deepEqual(
      reader.contactReads.map((item) => item.contactRef),
      ['teste-no-site'],
    );
    assert.ok(h.llm.calls[1]?.systemPrompt.includes(MY_APPOINTMENTS_BLOCK_OPEN));
  });

  it('falha ao listar os agendamentos do contato: atende sem a lista e sem fallback', async () => {
    const h = await setup(
      new FakeReader(undefined, () => Promise.reject(new Error(`falha ${SECRET_SERVICE}`))),
    );
    const result = await h.service.handleInboundMessage(h.company.id, {
      contactRef: 'teste-no-site',
      text: 'quero agendar',
    });
    assert.equal(result.reply.isFallback, false);
    assert.equal(h.llm.calls[0]?.systemPrompt.includes(MY_APPOINTMENTS_BLOCK_OPEN), false);
    assert.deepEqual(h.llm.toolsOffered, [['listar_horarios']]);
    assert.equal(logContains(h.logs.raw(), SECRET_SERVICE), false);
  });

  it('o provedor falha no meio do laço: texto padrão (isFallback), métrica provider_error', async () => {
    const h = await setup(new FakeReader());
    const result = await h.service.handleInboundMessage(h.company.id, {
      contactRef: 'c1',
      text: 'quero agendar [[mock:fail]]',
    });
    assert.equal(result.reply.isFallback, true);
    assert.deepEqual(h.metrics.toolTurns, ['provider_error']);
    assert.deepEqual(h.metrics.rounds, [0]);
    assert.equal(h.metrics.fallbacks.length, 1);
  });

  it('teto de rodadas: erro, texto padrão e métrica round_cap', async () => {
    const h = await setup(new FakeReader());
    h.llm.scriptTools({
      rounds: [[call('a')], [call('a')], [call('a')], [call('a')]],
      finalText: 'nunca',
    });
    const result = await h.service.handleInboundMessage(h.company.id, {
      contactRef: 'c1',
      text: 'quero agendar',
    });
    assert.equal(result.reply.isFallback, true);
    assert.deepEqual(h.metrics.toolTurns, ['round_cap']);
  });

  it('o prazo total do laço (30 s por padrão; aqui curto) estoura: texto padrão e a chamada é abortada', async (t) => {
    t.after(keepEventLoopAlive());
    const h = await setup(new FakeReader(), { turnTimeoutMs: 40 });
    const result = await h.service.handleInboundMessage(h.company.id, {
      contactRef: 'c1',
      text: `quero agendar ${MOCK_HANG_MARKER}`,
    });
    assert.equal(result.reply.isFallback, true);
    assert.deepEqual(h.metrics.toolTurns, ['provider_error']);
  });

  it('privacidade: log, métricas e fontes sem argumento, resultado, nome de serviço nem horário', async () => {
    const h = await setup(new FakeReader());
    h.llm.scriptTools({
      rounds: [[call(SECRET_SERVICE)], [call('Arg-Secreto-Girafa')]],
      finalText: 'Posso ajudar.',
    });
    const result = await h.service.handleInboundMessage(h.company.id, {
      contactRef: '5511999990000',
      text: `quero agendar ${SECRET_TEXT}`,
    });
    const raw = h.logs.raw();
    for (const secret of [
      SECRET_SERVICE,
      SECRET_TEXT,
      'Arg-Secreto-Girafa',
      '5511999990000',
      '09:00',
      '2026-11-11',
    ]) {
      assert.equal(logContains(raw, secret), false, secret);
    }
    assert.equal(JSON.stringify(h.metrics).includes(SECRET_SERVICE), false);
    assert.equal(JSON.stringify(result.sources).includes(SECRET_SERVICE), false);
    const served = h.logs.lines().find((line) => line['msg'] === 'mensagem atendida');
    assert.equal(served?.['toolRounds'], 2);
    assert.equal(served['toolCalls'], 2);
  });
});
