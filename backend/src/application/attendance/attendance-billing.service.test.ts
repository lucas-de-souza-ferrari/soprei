import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type CompanyEntitlements,
  type CompanyId,
  UNLIMITED_ENTITLEMENTS,
} from '../../domain/index.js';
import { MockLlmProvider } from '../../infrastructure/external-apis/llm/mock-llm.provider.js';
import { ForbiddenError } from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import { InMemoryAttendanceStore } from '../../test-support/in-memory-attendance.js';
import { InMemoryCompanyRepository } from '../../test-support/in-memory-company.repository.js';
import { captureLogs, logContains } from '../../test-support/log-capture.js';
import type { EntitlementReader } from '../ports/entitlement-reader.js';
import type { KnowledgeRetrieval, KnowledgeRetriever } from '../ports/knowledge-retriever.js';
import type {
  LlmGenerateInput,
  LlmGenerateOptions,
  LlmProvider,
  LlmReply,
} from '../ports/llm-provider.js';
import type {
  ContactAppointmentView,
  ScheduleAvailability,
  ScheduleAvailabilityReader,
} from '../ports/schedule-availability-reader.js';
import type { UsageMeter } from '../ports/usage-meter.js';
import type { ExternalServiceError } from '../../shared/errors/index.js';
import { AttendanceService } from './attendance.service.js';

const SECRET = 'zebrafantasma-segredo';
const BATCH = { maxMessages: 10, maxChars: 8_000 };

/** O mock com `usage` fixo: o provedor real informa tokens, o mock não. */
class UsageLlm implements LlmProvider {
  readonly name = 'mock';
  readonly inner = new MockLlmProvider({ recordCalls: true });
  usage: LlmReply['usage'] = { inputTokens: 100, outputTokens: 20 };
  async generate(
    input: LlmGenerateInput,
    options?: LlmGenerateOptions,
  ): Promise<Result<LlmReply, ExternalServiceError>> {
    const result = await this.inner.generate(input, options);
    if (!result.ok) return result;
    return Result.ok({
      ...result.value,
      ...(this.usage === undefined ? {} : { usage: this.usage }),
    });
  }
}

class FakeReader implements EntitlementReader {
  reads = 0;
  constructor(public behavior: () => Promise<CompanyEntitlements>) {}
  forCompany(): Promise<CompanyEntitlements> {
    this.reads += 1;
    return this.behavior();
  }
}

class FakeMeter implements Pick<UsageMeter, 'record'> {
  readonly recorded: { companyId: CompanyId; tokens: number }[] = [];
  fail = false;
  record(companyId: CompanyId, tokens: number): Promise<void> {
    if (this.fail) return Promise.reject(new Error(`falha com ${SECRET}`));
    this.recorded.push({ companyId, tokens });
    return Promise.resolve();
  }
}

class FakeMetrics {
  readonly blocks: string[] = [];
  usageErrors = 0;
  entitlementErrors = 0;
  observeLlmRequest(): void {}
  countAttendanceFallback(): void {}
  countQuotaBlock(reason: string): void {
    this.blocks.push(reason);
  }
  countUsageMeterError(): void {
    this.usageErrors += 1;
  }
  countEntitlementError(): void {
    this.entitlementErrors += 1;
  }
}

const PRODUCTS: KnowledgeRetrieval = {
  passages: [{ documentId: 'd1', title: 'Trocas', content: 'Trocas em até 7 dias.' }],
  products: [
    {
      productId: 'p1',
      sku: 'CAM-001',
      name: 'Camiseta Azul',
      description: '',
      priceCents: 5_990,
      quantity: 3,
      updatedAt: new Date('2026-11-04T17:32:00Z'),
    },
  ],
  hasAnyKnowledge: true,
};

const AVAILABILITY: ScheduleAvailability = {
  timezone: 'America/Sao_Paulo',
  generatedAt: new Date('2026-11-10T17:32:00.000Z'),
  today: '2026-11-10',
  hasSchedule: true,
  services: [
    {
      name: 'Corte',
      durationMinutes: 30,
      slots: [{ localDate: '2026-11-11', localStart: '09:00' }],
    },
  ],
};

function entitlements(overrides: Partial<CompanyEntitlements> = {}): CompanyEntitlements {
  return {
    access: 'ok',
    agenda: true,
    stock: true,
    tokens: { used: 10, limit: 1_000 },
    replies: { used: 1, limit: 100 },
    ...overrides,
  };
}

async function setup(
  options: {
    reader?: FakeReader | undefined;
    meter?: FakeMeter | undefined;
    scheduleReads?: { count: number };
    aiEnabled?: boolean;
  } = {},
) {
  const companies = new InMemoryCompanyRepository();
  const store = new InMemoryAttendanceStore();
  const llm = new UsageLlm();
  const logs = captureLogs();
  const metrics = new FakeMetrics();
  const scheduleReads = options.scheduleReads ?? { count: 0 };
  const retrieved: { count: number } = { count: 0 };
  const knowledge: KnowledgeRetriever = {
    retrieve: () => {
      retrieved.count += 1;
      return Promise.resolve(PRODUCTS);
    },
  };
  const schedule: ScheduleAvailabilityReader = {
    read: () => {
      scheduleReads.count += 1;
      return Promise.resolve(AVAILABILITY);
    },
    readContactAppointments: (): Promise<readonly ContactAppointmentView[]> => Promise.resolve([]),
  };
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
      ...(options.aiEnabled === true ? { scheduleAiEnabled: true } : {}),
    },
    knowledge,
    schedule,
    ...(options.reader === undefined ? {} : { entitlements: options.reader }),
    ...(options.meter === undefined ? {} : { usage: options.meter }),
  });
  const company = await companies.create({ name: 'Loja', slug: 'loja' });
  return { service, llm, logs, metrics, store, company, scheduleReads, retrieved };
}

describe('AttendanceService com cobrança (spec 031, E2)', () => {
  it('sem leitor nem medidor (BILLING_ENABLED=false) o atendimento é o de sempre, sem nenhuma consulta extra', async () => {
    const h = await setup();
    const result = await h.service.handleInboundMessage(h.company.id, {
      contactRef: 'c1',
      text: 'quanto custa a camiseta?',
    });
    assert.equal(result.reply.isFallback, false);
    assert.equal(h.llm.inner.calls.length, 1);
    // O systemPrompt recebe os produtos (o módulo não é consultado) e nada de cota é registrado.
    assert.match(h.llm.inner.calls[0]?.systemPrompt ?? '', /Camiseta Azul/);
    assert.deepEqual(h.metrics.blocks, []);
  });

  it('com entitlements ilimitados o prompt e a resposta são idênticos aos do atendimento sem cobrança', async () => {
    const plain = await setup();
    const billed = await setup({
      reader: new FakeReader(() => Promise.resolve(UNLIMITED_ENTITLEMENTS)),
    });
    await plain.service.handleInboundMessage(plain.company.id, {
      contactRef: 'c1',
      text: 'oi camiseta',
    });
    await billed.service.handleInboundMessage(billed.company.id, {
      contactRef: 'c1',
      text: 'oi camiseta',
    });
    assert.equal(billed.llm.inner.calls[0]?.systemPrompt, plain.llm.inner.calls[0]?.systemPrompt);
  });

  it('um turno soma inputTokens + outputTokens do usage na assinatura, uma vez por turno (simulador)', async () => {
    const meter = new FakeMeter();
    const reader = new FakeReader(() => Promise.resolve(entitlements()));
    const h = await setup({ reader, meter });
    await h.service.handleInboundMessage(h.company.id, { contactRef: 'c1', text: 'oi' });
    assert.deepEqual(meter.recorded, [{ companyId: h.company.id, tokens: 120 }]);
    // Uma leitura de cota por turno.
    assert.equal(reader.reads, 1);
  });

  it('resposta sem usage não incrementa', async () => {
    const meter = new FakeMeter();
    const h = await setup({ meter });
    h.llm.usage = undefined;
    await h.service.handleInboundMessage(h.company.id, { contactRef: 'c1', text: 'oi' });
    assert.deepEqual(meter.recorded, []);
  });

  it('o canal também mede (respondToPending) e o texto do contato nunca vai ao medidor nem ao log', async () => {
    const meter = new FakeMeter();
    const h = await setup({ reader: new FakeReader(() => Promise.resolve(entitlements())), meter });
    await h.service.acceptInboundMessage(h.company.id, {
      contactRef: 'c1',
      text: `oi ${SECRET}`,
      externalId: 'w1',
    });
    const response = await h.service.respondToPending(h.company.id, 'c1', BATCH);
    assert.equal(response.outcome, 'answered');
    assert.deepEqual(meter.recorded, [{ companyId: h.company.id, tokens: 120 }]);
    assert.equal(logContains(h.logs.raw(), SECRET), false);
  });

  it('falha do medidor não derruba a resposta: warn só com ids, métrica e nada do texto', async () => {
    const meter = new FakeMeter();
    meter.fail = true;
    const h = await setup({ meter });
    const result = await h.service.handleInboundMessage(h.company.id, {
      contactRef: 'c1',
      text: `oi ${SECRET}`,
    });
    assert.equal(result.reply.isFallback, false);
    assert.equal(h.metrics.usageErrors, 1);
    assert.equal(logContains(h.logs.raw(), SECRET), false);
  });

  for (const [name, patch, reason, code] of [
    ['respostas', { replies: { used: 100, limit: 100 } }, 'replies', 'QUOTA_EXCEEDED'],
    ['tokens', { tokens: { used: 1_000, limit: 1_000 } }, 'tokens', 'QUOTA_EXCEEDED'],
    ['assinatura inativa', { access: 'blocked' as const }, 'inactive', 'SUBSCRIPTION_INACTIVE'],
  ] as const) {
    it(`cota esgotada (${name}): o provedor não é chamado; simulador responde 403 e o canal não envia nada`, async () => {
      const meter = new FakeMeter();
      const h = await setup({
        reader: new FakeReader(() => Promise.resolve(entitlements(patch))),
        meter,
      });
      // Simulador: 403 com código próprio, mensagem gravada, nenhuma chamada ao modelo.
      await assert.rejects(
        () => h.service.handleInboundMessage(h.company.id, { contactRef: 'c1', text: 'oi' }),
        (error: unknown) => error instanceof ForbiddenError && error.code === code,
      );
      // Canal: outcome 'blocked', sem resposta, mensagens seguem pendentes.
      await h.service.acceptInboundMessage(h.company.id, {
        contactRef: 'c2',
        text: 'oi',
        externalId: 'w2',
      });
      const response = await h.service.respondToPending(h.company.id, 'c2', BATCH);
      assert.equal(response.outcome, 'blocked');
      assert.equal(response.reply, null);
      assert.equal(response.hasMorePending, false);
      assert.equal(await h.service.hasPendingMessages(h.company.id, 'c2'), true);
      assert.equal(h.llm.inner.calls.length, 0);
      assert.deepEqual(meter.recorded, []);
      assert.deepEqual(h.metrics.blocks, [reason, reason]);
    });
  }

  it('com a janela nova (cota zerada) a IA volta a responder', async () => {
    let blocked = true;
    const reader = new FakeReader(() =>
      Promise.resolve(entitlements(blocked ? { replies: { used: 100, limit: 100 } } : {})),
    );
    const h = await setup({ reader });
    await assert.rejects(() =>
      h.service.handleInboundMessage(h.company.id, { contactRef: 'c1', text: 'oi' }),
    );
    blocked = false;
    const result = await h.service.handleInboundMessage(h.company.id, {
      contactRef: 'c1',
      text: 'oi',
      externalId: 'retry-1',
    });
    assert.equal(result.reply.isFallback, false);
    assert.equal(h.llm.inner.calls.length, 1);
  });

  it('falha ao ler a cota é fail-open: atende, avisa com ids e conta o erro', async () => {
    const reader = new FakeReader(() => Promise.reject(new Error(`banco fora ${SECRET}`)));
    const h = await setup({ reader });
    const result = await h.service.handleInboundMessage(h.company.id, {
      contactRef: 'c1',
      text: 'oi',
    });
    assert.equal(result.reply.isFallback, false);
    assert.equal(h.metrics.entitlementErrors, 1);
    assert.equal(logContains(h.logs.raw(), SECRET), false);
  });

  it('sem o módulo Estoque os produtos não chegam ao prompt nem às fontes; com ele chegam', async () => {
    const without = await setup({
      reader: new FakeReader(() => Promise.resolve(entitlements({ stock: false }))),
    });
    const a = await without.service.handleInboundMessage(without.company.id, {
      contactRef: 'c1',
      text: 'quanto custa a camiseta azul?',
    });
    assert.doesNotMatch(without.llm.inner.calls[0]?.systemPrompt ?? '', /Camiseta Azul|CAM-001/);
    assert.ok(a.sources.every((source) => source.kind !== 'product'));
    const withStock = await setup({
      reader: new FakeReader(() => Promise.resolve(entitlements({ stock: true }))),
    });
    await withStock.service.handleInboundMessage(withStock.company.id, {
      contactRef: 'c1',
      text: 'quanto custa a camiseta azul?',
    });
    assert.match(withStock.llm.inner.calls[0]?.systemPrompt ?? '', /Camiseta Azul/);
  });

  it('sem o módulo Agenda não há leitura da agenda, bloco, lista nem ferramentas, mesmo com a IA da agenda ligada', async () => {
    const without = await setup({
      aiEnabled: true,
      reader: new FakeReader(() => Promise.resolve(entitlements({ agenda: false }))),
    });
    await without.service.handleInboundMessage(without.company.id, {
      contactRef: 'c1',
      text: 'tem horario amanha?',
    });
    assert.equal(without.scheduleReads.count, 0);
    assert.doesNotMatch(
      without.llm.inner.calls[0]?.systemPrompt ?? '',
      /<agenda>|meus_agendamentos/,
    );
    assert.deepEqual(without.llm.inner.toolsOffered, [undefined]);
    const withAgenda = await setup({
      aiEnabled: true,
      reader: new FakeReader(() => Promise.resolve(entitlements({ agenda: true }))),
    });
    await withAgenda.service.handleInboundMessage(withAgenda.company.id, {
      contactRef: 'c1',
      text: 'tem horario amanha?',
    });
    assert.equal(withAgenda.scheduleReads.count, 1);
    assert.ok(withAgenda.llm.inner.toolsOffered[0] !== undefined);
  });
});
