import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CompanyId } from '../../domain/index.js';
import { MockLlmProvider } from '../../infrastructure/external-apis/llm/mock-llm.provider.js';
import { InMemoryAttendanceStore } from '../../test-support/in-memory-attendance.js';
import { InMemoryCompanyRepository } from '../../test-support/in-memory-company.repository.js';
import { captureLogs, logContains } from '../../test-support/log-capture.js';
import type { KnowledgeRetrieval, KnowledgeRetriever } from '../ports/knowledge-retriever.js';
import {
  ATTENDANCE_STYLE_INSTRUCTION,
  AttendanceService,
  buildSystemPrompt,
} from './attendance.service.js';
import { KNOWLEDGE_BLOCK_CLOSE, KNOWLEDGE_BLOCK_OPEN } from './knowledge-prompt.js';

const SECRET_QUERY = 'zebrafantasma';
const BATCH_LIMITS = { maxMessages: 10, maxChars: 8_000 };

class FakeRetriever implements KnowledgeRetriever {
  readonly queries: { companyId: CompanyId; tsquery: string }[] = [];
  constructor(private readonly behavior: () => Promise<KnowledgeRetrieval>) {}
  retrieve(companyId: CompanyId, tsquery: string): Promise<KnowledgeRetrieval> {
    this.queries.push({ companyId, tsquery });
    return this.behavior();
  }
}

const HIT: KnowledgeRetrieval = {
  passages: [{ documentId: 'd1', title: 'Política de trocas', content: 'Trocas em até 7 dias.' }],
  products: [
    {
      productId: 'p1',
      sku: 'CAM-001',
      name: 'Camiseta Azul',
      description: '',
      priceCents: 5_990,
      quantity: 0,
      updatedAt: new Date('2026-11-04T17:32:00Z'),
    },
  ],
  hasAnyKnowledge: true,
};

class FakeMetrics {
  readonly knowledge: string[] = [];
  observeLlmRequest(): void {}
  countAttendanceFallback(): void {}
  countKnowledgeRetrieval(result: string): void {
    this.knowledge.push(result);
  }
}

async function setup(retriever: KnowledgeRetriever | undefined, knowledgeTimeoutMs?: number) {
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
      ...(knowledgeTimeoutMs === undefined ? {} : { knowledgeTimeoutMs }),
    },
    ...(retriever === undefined ? {} : { knowledge: retriever }),
  });
  const company = await companies.create({ name: 'Loja', slug: 'loja' });
  return { service, llm, logs, metrics, store, company };
}

describe('AttendanceService com base de conhecimento (spec 026)', () => {
  it('o systemPrompt é persona + estilo + bloco; o texto do contato vai só em userMessage', async () => {
    const retriever = new FakeRetriever(() => Promise.resolve(HIT));
    const h = await setup(retriever);
    const result = await h.service.handleInboundMessage(h.company.id, {
      contactRef: 'c1',
      text: `qual o prazo de troca ${SECRET_QUERY}?`,
    });
    const call = h.llm.calls[0];
    assert.ok(call !== undefined);
    const base = buildSystemPrompt(h.company);
    assert.ok(call.systemPrompt.startsWith(`${base}\n\n`));
    assert.ok(call.systemPrompt.includes(KNOWLEDGE_BLOCK_OPEN));
    assert.ok(call.systemPrompt.includes(KNOWLEDGE_BLOCK_CLOSE));
    assert.equal(call.systemPrompt.includes(SECRET_QUERY), false);
    assert.ok(call.userMessage.includes(SECRET_QUERY));
    assert.ok(call.systemPrompt.includes('sem estoque no momento'));
    assert.ok(result.reply.text.endsWith('(conhecimento: 1 trechos, 1 produtos)'));
    assert.deepEqual(result.sources, [
      { kind: 'document', label: 'Política de trocas' },
      { kind: 'product', label: 'Camiseta Azul' },
    ]);
    assert.deepEqual(h.metrics.knowledge, ['hit']);
    assert.equal(retriever.queries[0]?.companyId, h.company.id);
    assert.ok(retriever.queries[0].tsquery.includes('prazo'));
  });

  it('o mock continua cortando a persona certo com o bloco depois do estilo', async () => {
    const h = await setup(new FakeRetriever(() => Promise.resolve(HIT)));
    const result = await h.service.handleInboundMessage(h.company.id, {
      contactRef: 'c1',
      text: 'qual o prazo de troca?',
    });
    assert.ok(result.reply.text.includes('(persona: "Você é o assistente de atendimento de Loja.'));
    assert.ok(!result.reply.text.includes(ATTENDANCE_STYLE_INSTRUCTION.slice(0, 20)));
  });

  it('sem base e sem acerto: systemPrompt idêntico ao de hoje e sem fontes', async () => {
    const empty: KnowledgeRetrieval = { passages: [], products: [], hasAnyKnowledge: false };
    const h = await setup(new FakeRetriever(() => Promise.resolve(empty)));
    const result = await h.service.handleInboundMessage(h.company.id, {
      contactRef: 'c1',
      text: 'qual o prazo de troca?',
    });
    assert.equal(h.llm.calls[0]?.systemPrompt, buildSystemPrompt(h.company));
    assert.deepEqual(result.sources, []);
    assert.equal(result.reply.text.includes('conhecimento:'), false);
    assert.deepEqual(h.metrics.knowledge, ['skipped']);
  });

  it('com base e sem acerto: tem a linha de "vou confirmar" e a métrica empty', async () => {
    const none: KnowledgeRetrieval = { passages: [], products: [], hasAnyKnowledge: true };
    const h = await setup(new FakeRetriever(() => Promise.resolve(none)));
    await h.service.handleInboundMessage(h.company.id, {
      contactRef: 'c1',
      text: 'qual o prazo de troca?',
    });
    assert.ok(h.llm.calls[0]?.systemPrompt.includes('diga que vai confirmar'));
    assert.deepEqual(h.metrics.knowledge, ['empty']);
  });

  it('pergunta sem palavra útil não consulta a base (skipped)', async () => {
    const retriever = new FakeRetriever(() => Promise.resolve(HIT));
    const h = await setup(retriever);
    await h.service.handleInboundMessage(h.company.id, { contactRef: 'c1', text: 'e aí?' });
    assert.equal(retriever.queries.length, 0);
    assert.equal(h.llm.calls[0]?.systemPrompt, buildSystemPrompt(h.company));
    assert.deepEqual(h.metrics.knowledge, ['skipped']);
  });

  it('fail-open: erro na recuperação atende sem contexto, sem fallback, e loga só ids', async () => {
    const retriever = new FakeRetriever(() =>
      Promise.reject(new Error(`falha com ${SECRET_QUERY} no SQL`)),
    );
    const h = await setup(retriever);
    const result = await h.service.handleInboundMessage(h.company.id, {
      contactRef: 'c1',
      text: `preço da ${SECRET_QUERY}`,
    });
    assert.equal(result.reply.isFallback, false);
    assert.equal(h.llm.calls[0]?.systemPrompt, buildSystemPrompt(h.company));
    assert.deepEqual(h.metrics.knowledge, ['error']);
    const warn = h.logs.lines().find((line) => line['reason'] === 'error');
    assert.ok(warn !== undefined);
    assert.equal(logContains(h.logs.raw(), SECRET_QUERY), false);
  });

  it('fail-open: recuperação que não termina estoura o prazo (timeout) e o atendimento segue', async () => {
    const retriever = new FakeRetriever(
      () =>
        new Promise<KnowledgeRetrieval>(() => {
          // nunca termina
        }),
    );
    const h = await setup(retriever, 30);
    const result = await h.service.handleInboundMessage(h.company.id, {
      contactRef: 'c1',
      text: 'qual o prazo de troca?',
    });
    assert.equal(result.reply.isFallback, false);
    assert.equal(h.llm.calls[0]?.systemPrompt, buildSystemPrompt(h.company));
    assert.deepEqual(h.metrics.knowledge, ['timeout']);
  });

  it('o lote do canal (respondToPending) também recupera e o log só tem números', async () => {
    const retriever = new FakeRetriever(() => Promise.resolve(HIT));
    const h = await setup(retriever);
    await h.service.acceptInboundMessage(h.company.id, {
      contactRef: 'c9',
      text: `qual o prazo de troca ${SECRET_QUERY}?`,
    });
    const response = await h.service.respondToPending(h.company.id, 'c9', BATCH_LIMITS);
    assert.equal(response.outcome, 'answered');
    assert.ok(response.reply?.text.endsWith('(conhecimento: 1 trechos, 1 produtos)'));
    const call = h.llm.calls[0];
    assert.ok(call !== undefined);
    assert.ok(call.systemPrompt.includes(KNOWLEDGE_BLOCK_OPEN));
    assert.equal(call.systemPrompt.includes(SECRET_QUERY), false);
    const done = h.logs.lines().find((line) => line['knowledgePassages'] === 1);
    assert.equal(done?.['knowledgeProducts'], 1);
    for (const secret of [SECRET_QUERY, 'Política de trocas', 'Camiseta Azul', 'CAM-001']) {
      assert.equal(logContains(h.logs.raw(), secret), false, secret);
    }
  });

  it('resposta repetida (mesmo externalId) devolve sources vazio', async () => {
    const h = await setup(new FakeRetriever(() => Promise.resolve(HIT)));
    const input = { contactRef: 'c1', text: 'qual o prazo de troca?', externalId: 'ext-1' };
    const first = await h.service.handleInboundMessage(h.company.id, input);
    const again = await h.service.handleInboundMessage(h.company.id, input);
    assert.equal(first.sources.length, 2);
    assert.equal(again.duplicate, true);
    assert.deepEqual(again.sources, []);
  });
});
