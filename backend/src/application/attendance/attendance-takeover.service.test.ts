import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AI_TAKEOVER_PAUSE_MS,
  type Company,
  HUMAN_MEDIA_PLACEHOLDER,
  MESSAGE_CONTENT_MAX_LENGTH,
} from '../../domain/index.js';
import { MockLlmProvider } from '../../infrastructure/external-apis/llm/mock-llm.provider.js';
import { ForbiddenError, NotFoundError } from '../../shared/errors/index.js';
import { InMemoryAttendanceStore } from '../../test-support/in-memory-attendance.js';
import { InMemoryCompanyRepository } from '../../test-support/in-memory-company.repository.js';
import { captureLogs, logContains } from '../../test-support/log-capture.js';
import type { BatchLimits } from './attendance.schemas.js';
import {
  type AttendanceMetrics,
  AttendanceService,
  humanEchoContent,
} from './attendance.service.js';

const SECRET_CONTACT_TEXT = 'texto-secreto-do-contato-e039';
const SECRET_HUMAN_TEXT = 'texto-secreto-da-equipe-e039';
const CONTACT = '5511987654321';
const LIMITS: BatchLimits = { maxMessages: 10, maxChars: 8_000 };
const START = Date.UTC(2026, 10, 12, 12, 0, 0);

/** Relógio controlado: anda 1 ms a cada leitura (nunca repete) e salta com `advance`. */
function controlledClock(): { now: () => Date; advance: (ms: number) => void; peek: () => Date } {
  let time = START;
  return {
    now: () => {
      time += 1;
      return new Date(time);
    },
    advance: (ms) => {
      time += ms;
    },
    peek: () => new Date(time),
  };
}

class FakeMetrics implements AttendanceMetrics {
  paused = 0;
  resumes = 0;
  observeLlmRequest(): void {
    // não interessa aqui
  }
  countAttendanceFallback(): void {
    // não interessa aqui
  }
  countPausedTurn(): void {
    this.paused += 1;
  }
  countAiResume(): void {
    this.resumes += 1;
  }
}

function setup(options: { handoffEnabled?: boolean } = {}) {
  const clock = controlledClock();
  const companies = new InMemoryCompanyRepository();
  const store = new InMemoryAttendanceStore(clock.now);
  const llm = new MockLlmProvider({ recordCalls: true });
  const metrics = new FakeMetrics();
  const logs = captureLogs();
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
      now: clock.now,
      ...(options.handoffEnabled === true ? { handoffEnabled: true } : {}),
    },
  });
  return { clock, companies, store, llm, metrics, logs, service };
}

type Harness = ReturnType<typeof setup>;

async function newCompany(h: Harness, slug: string): Promise<Company> {
  return h.companies.create({ name: `Empresa ${slug}`, slug });
}

let sequence = 0;
function contactSays(h: Harness, company: Company, text: string, contactRef = CONTACT) {
  sequence += 1;
  return h.service.acceptInboundMessage(
    company.id,
    { contactRef, text, externalId: `wamid.in.${String(sequence)}` },
    { receivedAt: h.clock.now() },
  );
}

function teamSays(
  h: Harness,
  company: Company,
  text: string | undefined,
  options: { contactRef?: string; externalId?: string; receivedAt?: Date } = {},
) {
  sequence += 1;
  return h.service.recordHumanEcho(
    company.id,
    {
      contactRef: options.contactRef ?? CONTACT,
      externalId: options.externalId ?? `wamid.echo.${String(sequence)}`,
      text,
    },
    { receivedAt: options.receivedAt ?? h.clock.now() },
  );
}

function conversationOf(h: Harness, company: Company, contactRef = CONTACT) {
  const row = h.store
    .allConversations()
    .find((candidate) => candidate.companyId === company.id && candidate.contactRef === contactRef);
  assert.ok(row, 'a conversa existe');
  return row;
}

describe('AttendanceService.recordHumanEcho (spec 039, E3)', () => {
  it('grava uma mensagem HUMAN no instante de recebimento e pausa a IA por 12 h', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    const receivedAt = h.clock.now();

    const result = await teamSays(h, company, SECRET_HUMAN_TEXT, { receivedAt });

    assert.equal(result.result, 'recorded');
    const [message] = h.store.allMessages();
    assert.ok(message);
    assert.equal(message.role, 'HUMAN');
    assert.equal(message.content, SECRET_HUMAN_TEXT);
    assert.equal(message.createdAt.getTime(), receivedAt.getTime());
    assert.equal(message.sentAt, null);
    const conversation = conversationOf(h, company);
    assert.equal(
      conversation.aiPausedUntil?.getTime(),
      receivedAt.getTime() + AI_TAKEOVER_PAUSE_MS,
    );
    assert.equal(conversation.aiIgnoreBefore?.getTime(), receivedAt.getTime());
    assert.equal(h.llm.calls.length, 0, 'o eco nunca chama o modelo');
  });

  it('o mesmo eco duas vezes não duplica nem muda o createdAt', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    const first = h.clock.now();
    await teamSays(h, company, 'oi', { externalId: 'wamid.echo.fixo', receivedAt: first });
    h.clock.advance(5_000);

    const again = await teamSays(h, company, 'oi', { externalId: 'wamid.echo.fixo' });

    assert.equal(again.result, 'duplicate');
    assert.equal(h.store.allMessages().length, 1);
    assert.equal(h.store.allMessages()[0]?.createdAt.getTime(), first.getTime());
  });

  it('um segundo eco só estende a pausa (nunca encurta)', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    const early = h.clock.now();
    h.clock.advance(60_000);
    const late = h.clock.now();

    await teamSays(h, company, 'depois', { receivedAt: late });
    await teamSays(h, company, 'antes', { receivedAt: early });

    const conversation = conversationOf(h, company);
    assert.equal(conversation.aiPausedUntil?.getTime(), late.getTime() + AI_TAKEOVER_PAUSE_MS);
    assert.equal(conversation.aiIgnoreBefore?.getTime(), late.getTime());
  });

  it('eco de uma resposta que o próprio Soprei enviou é ignorado (own), sem gravar nem pausar', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    await contactSays(h, company, 'oi');
    const response = await h.service.respondToPending(company.id, CONTACT, LIMITS);
    assert.ok(response.reply);
    await h.store.messages.markSent(company.id, response.reply.id, {
      channelMessageId: 'wamid.out.1',
      sentAt: h.clock.now(),
    });
    const before = h.store.allMessages().length;

    const result = await teamSays(h, company, response.reply.text, { externalId: 'wamid.out.1' });

    assert.equal(result.result, 'own');
    assert.equal(h.store.allMessages().length, before);
    assert.equal(conversationOf(h, company).aiPausedUntil, null);
  });

  it('mídia vira o texto fixo do servidor; texto acima do teto é cortado', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    await teamSays(h, company, undefined, { contactRef: '5511900000001' });
    await teamSays(h, company, '   ', { contactRef: '5511900000002' });
    await teamSays(h, company, 'x'.repeat(MESSAGE_CONTENT_MAX_LENGTH + 50), {
      contactRef: '5511900000003',
    });

    const contents = h.store.allMessages().map((message) => message.content);
    assert.equal(contents[0], HUMAN_MEDIA_PLACEHOLDER);
    assert.equal(contents[1], HUMAN_MEDIA_PLACEHOLDER);
    assert.equal(contents[2]?.length, MESSAGE_CONTENT_MAX_LENGTH);
    assert.equal(humanEchoContent('ok'), 'ok');
  });

  it('instante de recebimento fora da faixa: vale o relógio, com warn só do companyId', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');

    await teamSays(h, company, SECRET_HUMAN_TEXT, { receivedAt: new Date(START - 3 * 86_400_000) });

    const [message] = h.store.allMessages();
    assert.ok((message?.createdAt.getTime() ?? 0) > START, 'usou o relógio, não o instante antigo');
    const warn = h.logs.lines().find((line) => String(line['msg']).includes('fora da faixa'));
    assert.ok(warn);
    assert.equal(warn['companyId'], company.id);
    assert.equal(logContains(h.logs.raw(), SECRET_HUMAN_TEXT), false);
  });

  it('empresa suspensa: ForbiddenError e nada gravado', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    await h.companies.update(company.id, { status: 'SUSPENDED' });

    await assert.rejects(teamSays(h, company, 'oi'), ForbiddenError);
    assert.equal(h.store.allMessages().length, 0);
  });

  it('isolamento: o eco da empresa A não toca a conversa do mesmo contato na empresa B', async () => {
    const h = setup();
    const a = await newCompany(h, 'alfa');
    const b = await newCompany(h, 'beta');
    await contactSays(h, b, 'oi da B');

    await teamSays(h, a, 'oi da A');

    assert.equal(conversationOf(h, b).aiPausedUntil, null);
    assert.equal(
      h.store
        .allMessages()
        .filter((message) => message.companyId === b.id && message.role === 'HUMAN').length,
      0,
    );
    const answered = await h.service.respondToPending(b.id, CONTACT, LIMITS);
    assert.equal(answered.outcome, 'answered', 'a B segue respondendo');
  });
});

describe('Pausa da IA no respondToPending (spec 039, E3)', () => {
  it('mensagens pendentes ANTES do eco não são respondidas depois', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    await contactSays(h, company, SECRET_CONTACT_TEXT);
    await teamSays(h, company, SECRET_HUMAN_TEXT);

    const response = await h.service.respondToPending(company.id, CONTACT, LIMITS);

    assert.equal(response.outcome, 'paused');
    assert.equal(response.reply, null);
    assert.equal(h.llm.calls.length, 0);
    assert.equal(await h.service.hasPendingMessages(company.id, CONTACT), false);
  });

  it('durante a pausa: sem LLM, sem resposta, sem envio; a mensagem sai das pendentes', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    await teamSays(h, company, SECRET_HUMAN_TEXT);
    h.clock.advance(60_000);
    await contactSays(h, company, SECRET_CONTACT_TEXT);
    assert.equal(await h.service.hasPendingMessages(company.id, CONTACT), true);

    const response = await h.service.respondToPending(company.id, CONTACT, LIMITS);

    assert.equal(response.outcome, 'paused');
    assert.equal(h.llm.calls.length, 0);
    assert.equal(h.store.allMessages().filter((m) => m.role === 'ASSISTANT').length, 0);
    assert.equal(await h.service.hasPendingMessages(company.id, CONTACT), false);
    assert.equal(h.metrics.paused, 1);
    assert.equal(await h.service.isAiPausedFor(company.id, CONTACT), true);
  });

  it('pausa vencida: responde só o que chegou depois; a HUMAN vai ao modelo como turno do assistente', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    await contactSays(h, company, 'antes-do-eco');
    await teamSays(h, company, SECRET_HUMAN_TEXT);
    h.clock.advance(AI_TAKEOVER_PAUSE_MS + 1_000);
    assert.equal(await h.service.isAiPausedFor(company.id, CONTACT), false);
    await contactSays(h, company, SECRET_CONTACT_TEXT);

    const response = await h.service.respondToPending(company.id, CONTACT, LIMITS);

    assert.equal(response.outcome, 'answered');
    assert.equal(response.batchSize, 1);
    const call = h.llm.calls[0];
    assert.ok(call);
    assert.equal(call.userMessage, SECRET_CONTACT_TEXT, 'o texto do contato só no turno user');
    assert.ok(!call.systemPrompt.includes(SECRET_CONTACT_TEXT));
    assert.ok(!call.systemPrompt.includes(SECRET_HUMAN_TEXT));
    assert.deepEqual(
      call.history.map((turn) => [turn.role, turn.content]),
      [
        ['user', 'antes-do-eco'],
        ['assistant', SECRET_HUMAN_TEXT],
      ],
    );
  });

  it('corrida: eco durante a chamada ao modelo desfaz a resposta (nada gravado da IA)', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    await contactSays(h, company, SECRET_CONTACT_TEXT);
    const release = h.llm.hold();

    const turn = h.service.respondToPending(company.id, CONTACT, LIMITS);
    // Espera a chamada chegar ao modelo (o turno está "pensando").
    for (let i = 0; i < 100 && h.llm.calls.length === 0; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(h.llm.calls.length, 1);
    await teamSays(h, company, SECRET_HUMAN_TEXT);
    release();
    const response = await turn;

    assert.equal(response.outcome, 'paused');
    assert.equal(response.reply, null);
    assert.equal(h.store.allMessages().filter((m) => m.role === 'ASSISTANT').length, 0);
    assert.equal(
      h.store.allMessages().filter((m) => m.role === 'USER').length,
      1,
      'contato mantido',
    );
    assert.equal(h.store.allMessages().filter((m) => m.role === 'HUMAN').length, 1);
  });

  it('038: pedido de humano aberto continua aberto depois do eco; turno pausado não oferece ferramenta', async () => {
    const h = setup({ handoffEnabled: true });
    const company = await newCompany(h, 'alfa');
    await contactSays(h, company, 'quero falar com um atendente');
    await h.service.respondToPending(company.id, CONTACT, LIMITS);
    assert.equal(h.store.notifications.all().length, 1);

    await teamSays(h, company, SECRET_HUMAN_TEXT);
    await contactSays(h, company, 'quero falar com um atendente de novo');
    const calls = h.llm.calls.length;
    const response = await h.service.respondToPending(company.id, CONTACT, LIMITS);

    assert.equal(response.outcome, 'paused');
    assert.equal(h.llm.calls.length, calls, 'sem turno, sem ferramenta oferecida');
    const notifications = h.store.notifications.all();
    assert.equal(notifications.length, 1, 'a pausa não cria notificação');
    assert.equal(notifications[0]?.status, 'OPEN', 'o eco não resolve o pedido aberto (D4)');
  });

  it('nunca loga o texto do contato, o da equipe nem o telefone', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    await contactSays(h, company, SECRET_CONTACT_TEXT);
    await teamSays(h, company, SECRET_HUMAN_TEXT, { externalId: 'wamid.SEGREDO039' });
    await contactSays(h, company, SECRET_CONTACT_TEXT);
    await h.service.respondToPending(company.id, CONTACT, LIMITS);

    const raw = h.logs.raw();
    for (const secret of [SECRET_CONTACT_TEXT, SECRET_HUMAN_TEXT, CONTACT, 'wamid.SEGREDO039']) {
      assert.equal(logContains(raw, secret), false, secret);
    }
  });
});

describe('AttendanceService.resumeAi (spec 039, E4)', () => {
  it('zera a pausa, mantém o aiIgnoreBefore e é idempotente', async () => {
    const h = setup();
    const company = await newCompany(h, 'alfa');
    await contactSays(h, company, 'antes');
    await teamSays(h, company, 'equipe');
    const conversation = conversationOf(h, company);
    const ignoreBefore = conversation.aiIgnoreBefore;

    await h.service.resumeAi(company.id, conversation.id);
    await h.service.resumeAi(company.id, conversation.id);

    const after = conversationOf(h, company);
    assert.equal(after.aiPausedUntil, null);
    assert.equal(after.aiIgnoreBefore?.getTime(), ignoreBefore?.getTime());
    assert.equal(h.metrics.resumes, 2);
    // O que a equipe já tratou não volta: nada pendente; uma mensagem nova é respondida.
    assert.equal(await h.service.hasPendingMessages(company.id, CONTACT), false);
    await contactSays(h, company, 'depois');
    const response = await h.service.respondToPending(company.id, CONTACT, LIMITS);
    assert.equal(response.outcome, 'answered');
    assert.equal(response.batchSize, 1);
  });

  it('conversa de outra empresa, inexistente ou malformada: o mesmo NotFoundError', async () => {
    const h = setup();
    const a = await newCompany(h, 'alfa');
    const b = await newCompany(h, 'beta');
    await teamSays(h, a, 'equipe');
    const conversationA = conversationOf(h, a);

    await assert.rejects(h.service.resumeAi(b.id, conversationA.id), NotFoundError);
    await assert.rejects(
      h.service.resumeAi(a.id, '00000000-0000-7000-8000-00000000ffff'),
      NotFoundError,
    );
    await assert.rejects(h.service.resumeAi(a.id, 'nao-e-uuid'), NotFoundError);
    assert.notEqual(conversationOf(h, a).aiPausedUntil, null, 'a pausa da A não mudou');
  });
});
