import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { HandoffReason, NotificationCreateResult } from '../../domain/index.js';
import {
  MOCK_FAIL_MARKER,
  MOCK_HANDOFF_SUFFIX,
  MockLlmProvider,
} from '../../infrastructure/external-apis/llm/mock-llm.provider.js';
import { ConflictError } from '../../shared/errors/index.js';
import { InMemoryAttendanceStore } from '../../test-support/in-memory-attendance.js';
import { InMemoryCompanyRepository } from '../../test-support/in-memory-company.repository.js';
import { captureLogs, logContains } from '../../test-support/log-capture.js';
import { AttendanceService } from './attendance.service.js';
import {
  composeToolSet,
  createHandoffRecorder,
  HANDOFF_TOOL_NAME,
  HANDOFF_TOOL_OUTPUT,
} from './handoff-tool.js';

// Spec 038: o pedido de atendimento humano vira notificação na mesma transação da resposta.

const SECRET = 'zebrafantasma-atendente';
const LIMITS = { maxMessages: 10, maxChars: 8_000 };

class FakeMetrics {
  readonly handoffs: HandoffReason[] = [];
  readonly notifications: NotificationCreateResult[] = [];
  observeLlmRequest(): void {}
  countAttendanceFallback(): void {}
  countHandoff(reason: HandoffReason): void {
    this.handoffs.push(reason);
  }
  countNotificationCreated(result: NotificationCreateResult): void {
    this.notifications.push(result);
  }
}

async function setup(options: { notificationMaxOpen?: number; handoffEnabled?: boolean } = {}) {
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
      handoffEnabled: options.handoffEnabled ?? true,
      ...(options.notificationMaxOpen === undefined
        ? {}
        : { notificationMaxOpen: options.notificationMaxOpen }),
    },
  });
  const company = await companies.create({ name: 'Loja', slug: 'loja' });
  const other = await companies.create({ name: 'Outra', slug: 'outra' });
  return { service, store, llm, logs, metrics, company, other };
}

describe('AttendanceService: pedido de atendimento humano (spec 038)', () => {
  it('simulador: oferece o sinal ao provedor e grava uma notificação aberta ligada à conversa e à resposta', async () => {
    const h = await setup();
    const result = await h.service.handleInboundMessage(h.company.id, {
      contactRef: 'c1',
      text: `quero falar com um atendente ${SECRET}`,
    });
    assert.deepEqual(h.llm.toolsOffered[0], [HANDOFF_TOOL_NAME]);
    assert.ok(result.reply.text.endsWith(MOCK_HANDOFF_SUFFIX));
    const rows = h.store.notifications.all();
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.ok(row);
    assert.equal(row.companyId, h.company.id);
    assert.equal(row.kind, 'HUMAN_HANDOFF');
    assert.equal(row.reason, 'CONTACT_REQUESTED');
    assert.equal(row.status, 'OPEN');
    assert.equal(row.conversationId, result.conversationId);
    assert.equal(row.messageId, result.reply.id);
    assert.deepEqual(h.metrics.handoffs, ['CONTACT_REQUESTED']);
    assert.deepEqual(h.metrics.notifications, ['created']);
    // Log com o motivo e o resultado, nunca o texto do contato.
    assert.equal(logContains(h.logs.raw(), SECRET), false);
    assert.ok(h.logs.lines().some((line) => line['handoffReason'] === 'CONTACT_REQUESTED'));
  });

  it('desligado (padrão): o pedido ao provedor não leva ferramenta e nada é notificado', async () => {
    const h = await setup({ handoffEnabled: false });
    await h.service.handleInboundMessage(h.company.id, { contactRef: 'c1', text: 'atendente' });
    assert.deepEqual(h.llm.toolsOffered, [undefined]);
    assert.equal(h.store.notifications.all().length, 0);
  });

  it('pedido comum: a ferramenta é oferecida, não é chamada e nada é notificado', async () => {
    const h = await setup();
    await h.service.handleInboundMessage(h.company.id, {
      contactRef: 'c1',
      text: 'qual o horário?',
    });
    assert.equal(h.store.notifications.all().length, 0);
    assert.deepEqual(h.metrics.handoffs, []);
  });

  it('segundo pedido na mesma conversa não cria outra (deduplicated); depois de resolver, cria', async () => {
    const h = await setup();
    await h.service.handleInboundMessage(h.company.id, { contactRef: 'c1', text: 'atendente' });
    await h.service.handleInboundMessage(h.company.id, {
      contactRef: 'c1',
      text: 'atendente de novo',
    });
    assert.equal(h.store.notifications.all().length, 1);
    assert.deepEqual(h.metrics.notifications, ['created', 'deduplicated']);

    const [first] = h.store.notifications.all();
    assert.ok(first);
    await h.store.notifications.resolve(h.company.id, first.id, 'membro', new Date());
    await h.service.handleInboundMessage(h.company.id, {
      contactRef: 'c1',
      text: 'humano, por favor',
    });
    assert.equal(h.store.notifications.all().length, 2);
    assert.equal(await h.store.notifications.countOpen(h.company.id), 1);
  });

  it('mesmo externalId repetido não cria segunda notificação', async () => {
    const h = await setup();
    const input = { contactRef: 'c1', text: 'atendente', externalId: 'wamid.1' };
    await h.service.handleInboundMessage(h.company.id, input);
    const again = await h.service.handleInboundMessage(h.company.id, input);
    assert.equal(again.duplicate, true);
    assert.equal(h.store.notifications.all().length, 1);
  });

  it('fallback do LLM nunca cria notificação', async () => {
    const h = await setup();
    const result = await h.service.handleInboundMessage(h.company.id, {
      contactRef: 'c1',
      text: `atendente ${MOCK_FAIL_MARKER}`,
    });
    assert.equal(result.reply.isFallback, true);
    assert.equal(h.store.notifications.all().length, 0);
  });

  it('teto: com o máximo de abertas, o próximo pedido não cria e conta capped', async () => {
    const h = await setup({ notificationMaxOpen: 1 });
    await h.service.handleInboundMessage(h.company.id, { contactRef: 'c1', text: 'atendente' });
    await h.service.handleInboundMessage(h.company.id, { contactRef: 'c2', text: 'atendente' });
    assert.equal(h.store.notifications.all().length, 1);
    assert.deepEqual(h.metrics.notifications, ['created', 'capped']);
    // O teto é por empresa: outra empresa ainda cria.
    await h.service.handleInboundMessage(h.other.id, { contactRef: 'c1', text: 'atendente' });
    assert.equal(await h.store.notifications.countOpen(h.other.id), 1);
  });

  it('canal (respondToPending): o lote que pede humano cria a notificação com a resposta', async () => {
    const h = await setup();
    await h.service.acceptInboundMessage(h.company.id, { contactRef: 'c1', text: 'oi' });
    await h.service.acceptInboundMessage(h.company.id, {
      contactRef: 'c1',
      text: 'quero um atendente',
    });
    const response = await h.service.respondToPending(h.company.id, 'c1', LIMITS);
    assert.equal(response.outcome, 'answered');
    assert.deepEqual(h.llm.toolsOffered[0], [HANDOFF_TOOL_NAME]);
    const [row] = h.store.notifications.all();
    assert.ok(row);
    assert.equal(row.messageId, response.reply?.id);
    assert.equal(row.conversationId, response.conversationId);
  });

  it('transação desfeita: a notificação não fica gravada', async () => {
    const h = await setup();
    await h.service.acceptInboundMessage(h.company.id, { contactRef: 'c1', text: 'atendente' });
    // Falha DEPOIS de gravar a notificação, ainda dentro da transação: tudo desfaz junto.
    const original = h.store.notifications.createHandoff.bind(h.store.notifications);
    h.store.notifications.createHandoff = async (...args) => {
      await original(...args);
      throw new ConflictError('falha simulada depois da notificação');
    };
    await assert.rejects(h.service.respondToPending(h.company.id, 'c1', LIMITS), ConflictError);
    assert.equal(h.store.notifications.all().length, 0);
    assert.equal(
      h.store.allMessages().filter((message) => message.role === 'ASSISTANT').length,
      0,
      'a resposta também foi desfeita',
    );
  });
});

describe('ferramenta de atendimento humano (spec 038)', () => {
  it('registra o primeiro motivo válido; ausente ou fora da lista vira OTHER; o resultado é fixo', () => {
    const recorder = createHandoffRecorder();
    assert.equal(recorder.requested(), undefined);
    assert.deepEqual(
      recorder.execute({ name: HANDOFF_TOOL_NAME, input: { motivo: 'COMPLAINT' } }),
      HANDOFF_TOOL_OUTPUT,
    );
    recorder.execute({ name: HANDOFF_TOOL_NAME, input: { motivo: 'SENSITIVE' } });
    assert.equal(recorder.requested(), 'COMPLAINT');
    for (const input of [{}, { motivo: 'URGENTE' }, { motivo: 7 }, null, 'texto']) {
      const other = createHandoffRecorder();
      other.execute({ name: HANDOFF_TOOL_NAME, input });
      assert.equal(other.requested(), 'OTHER');
    }
  });

  it('a definição é estrita: um campo, enum fechado, sem campos extras', () => {
    const { definition } = createHandoffRecorder();
    const schema = definition.inputSchema as {
      properties: Record<string, { enum: string[] }>;
      required: string[];
      additionalProperties: boolean;
    };
    assert.deepEqual(Object.keys(schema.properties), ['motivo']);
    assert.deepEqual(schema.properties['motivo']?.enum, [
      'CONTACT_REQUESTED',
      'CANNOT_HELP',
      'COMPLAINT',
      'SENSITIVE',
      'OTHER',
    ]);
    assert.deepEqual(schema.required, ['motivo']);
    assert.equal(schema.additionalProperties, false);
  });

  it('sozinha: tetos de uma chamada e a resposta; nome desconhecido não executa nada', async () => {
    const recorder = createHandoffRecorder();
    const set = composeToolSet(recorder, undefined);
    assert.deepEqual(
      set.definitions.map((definition) => definition.name),
      [HANDOFF_TOOL_NAME],
    );
    assert.deepEqual(set.limits, { maxModelCalls: 2, maxToolCalls: 2 });
    const unknown = await set.execute({ name: 'apagar_tudo', input: {} });
    assert.equal(unknown.isError, true);
    assert.equal(recorder.requested(), undefined);
  });
});
