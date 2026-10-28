import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ZodError } from 'zod';
import type { Client, Message } from '../../domain/index.js';
import {
  MOCK_FAIL_MARKER,
  MockLlmProvider,
} from '../../infrastructure/external-apis/llm/mock-llm.provider.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../shared/errors/index.js';
import { steppingClock } from '../../test-support/clock.js';
import { InMemoryAttendanceStore } from '../../test-support/in-memory-attendance.js';
import { InMemoryClientRepository } from '../../test-support/in-memory-client.repository.js';
import { captureLogs } from '../../test-support/log-capture.js';
import {
  ATTENDANCE_FALLBACK_TEXT,
  type AttendanceMetrics,
  AttendanceService,
  type BatchResult,
} from './attendance.service.js';
import type { BatchLimits } from './attendance.schemas.js';

const SECRET_TEXT = 'texto-secreto-do-contato-b13';
const PERSONA = 'persona-secreta-da-empresa-b13';
const LIMITS: BatchLimits = { maxMessages: 10, maxChars: 8_000 };

class FakeMetrics implements AttendanceMetrics {
  readonly batches: { size: number; result: BatchResult }[] = [];
  fallbacks = 0;
  observeLlmRequest(): void {
    // não interessa aqui
  }
  countAttendanceFallback(): void {
    this.fallbacks += 1;
  }
  observeAttendanceBatch(sample: { size: number; result: BatchResult }): void {
    this.batches.push(sample);
  }
}

function setup() {
  // Relógio que anda 10 ms a cada leitura: mensagens nunca caem no mesmo instante.
  const now = steppingClock(10);
  const clients = new InMemoryClientRepository();
  const store = new InMemoryAttendanceStore(now);
  const llm = new MockLlmProvider({ recordCalls: true });
  const metrics = new FakeMetrics();
  const logs = captureLogs();
  const service = new AttendanceService({
    clients,
    conversations: store.conversations,
    messages: store.messages,
    unitOfWork: store,
    llm,
    logger: logs.logger,
    metrics,
    options: { llmTimeoutMs: 1_000, inFlightTimeoutMs: 60_000, now },
  });
  return { clients, store, llm, metrics, logs, service };
}

type Harness = ReturnType<typeof setup>;

async function newClient(
  h: Harness,
  slug: string,
  persona = `${PERSONA} ${slug}`,
): Promise<Client> {
  const client = await h.clients.create({ name: `Empresa ${slug}`, slug });
  return h.clients.update(client.id, { persona });
}

let sequence = 0;
/** Aceita uma mensagem do contato (sem LLM). */
function accept(h: Harness, client: Client, text: string, contactRef = 'contato-1') {
  sequence += 1;
  return h.service.acceptInboundMessage(client.id, {
    contactRef,
    text,
    externalId: `wamid.${String(sequence)}`,
  });
}

const sorted = (messages: readonly Message[]): Message[] =>
  [...messages].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

describe('AttendanceService.acceptInboundMessage (spec 013)', () => {
  it('grava a conversa e a mensagem do contato sem chamar o LLM, e diz desde quando há pendentes', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa');

    const first = await accept(h, client, 'primeira');
    const second = await accept(h, client, 'segunda');

    assert.equal(first.status, 'accepted');
    assert.equal(second.status, 'accepted');
    assert.equal(h.llm.calls.length, 0, 'nenhuma chamada ao LLM ao aceitar');
    assert.equal(h.store.allConversations().length, 1);
    const stored = h.store.allMessages();
    assert.deepEqual(
      stored.map((message) => [message.role, message.content, message.answeredById]),
      [
        ['USER', 'primeira', null],
        ['USER', 'segunda', null],
      ],
    );
    // A mais antiga pendente é a primeira; a data da mensagem é a dela mesma.
    assert.equal(first.oldestPendingAt?.getTime(), first.messageCreatedAt.getTime());
    assert.equal(second.oldestPendingAt?.getTime(), first.messageCreatedAt.getTime());
    assert.ok(second.messageCreatedAt.getTime() > first.messageCreatedAt.getTime());
  });

  it('é idempotente por externalId: reentrega de mensagem pendente não grava de novo (pending)', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa');
    const input = { contactRef: 'c1', text: 'oi', externalId: 'wamid.fixo' };

    const first = await h.service.acceptInboundMessage(client.id, input);
    const again = await h.service.acceptInboundMessage(client.id, input);

    assert.equal(first.status, 'accepted');
    assert.equal(again.status, 'pending');
    assert.equal(again.messageId, first.messageId);
    assert.equal(h.store.allMessages().length, 1);
  });

  it('reentrega de mensagem já respondida devolve answered e não grava nem responde', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa');
    const input = { contactRef: 'c1', text: 'oi', externalId: 'wamid.fixo' };
    await h.service.acceptInboundMessage(client.id, input);
    await h.service.respondToPending(client.id, 'c1', LIMITS);
    const llmCalls = h.llm.calls.length;
    const stored = h.store.allMessages().length;

    const again = await h.service.acceptInboundMessage(client.id, input);

    assert.equal(again.status, 'answered');
    assert.equal(again.oldestPendingAt, null);
    assert.equal(h.llm.calls.length, llmCalls);
    assert.equal(h.store.allMessages().length, stored);
  });

  it('externalId de outro contato é conflito, não duplicata', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa');
    await h.service.acceptInboundMessage(client.id, {
      contactRef: 'c1',
      text: 'oi',
      externalId: 'wamid.fixo',
    });
    await assert.rejects(
      h.service.acceptInboundMessage(client.id, {
        contactRef: 'c2',
        text: 'oi',
        externalId: 'wamid.fixo',
      }),
      /externalId já usado/,
    );
  });

  it('cliente suspenso (403) e removido (404): nada é gravado', async () => {
    const h = setup();
    const suspended = await newClient(h, 'alfa');
    await h.clients.update(suspended.id, { status: 'SUSPENDED' });
    const removed = await newClient(h, 'beta');
    await h.clients.delete(removed.id);

    await assert.rejects(accept(h, suspended, 'oi'), ForbiddenError);
    await assert.rejects(accept(h, removed, 'oi'), NotFoundError);
    assert.equal(h.store.allMessages().length, 0);
    assert.equal(h.store.allConversations().length, 0);
  });

  it('valida a entrada com Zod (texto vazio, NUL)', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa');
    await assert.rejects(accept(h, client, '   '), ZodError);
    await assert.rejects(accept(h, client, 'a\u0000b'), ZodError);
  });
});

describe('AttendanceService.respondToPending (spec 013)', () => {
  it('três mensagens pendentes: uma chamada ao LLM, um turno user com os textos em ordem separados por quebra de linha, e o histórico anterior à primeira', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa');
    // Um turno antigo já respondido: é o histórico.
    await accept(h, client, 'pergunta antiga');
    await h.service.respondToPending(client.id, 'contato-1', LIMITS);
    h.llm.calls.length = 0;

    await accept(h, client, 'oi');
    await accept(h, client, 'tudo bem?');
    await accept(h, client, 'preciso de ajuda');
    const result = await h.service.respondToPending(client.id, 'contato-1', LIMITS);

    assert.equal(h.llm.calls.length, 1);
    const [call] = h.llm.calls;
    assert.equal(call?.userMessage, 'oi\ntudo bem?\npreciso de ajuda');
    assert.deepEqual(
      call.history.map((turn) => turn.role),
      ['user', 'assistant'],
    );
    assert.equal(call.history[0]?.content, 'pergunta antiga');
    assert.match(call.systemPrompt, new RegExp(PERSONA));
    assert.ok(!call.systemPrompt.includes('oi\n'), 'o texto do contato nunca vai no systemPrompt');
    assert.equal(result.outcome, 'answered');
    assert.equal(result.batchSize, 3);
    assert.equal(result.hasMorePending, false);
    assert.match(result.reply?.text ?? '', /^\[mock\] Recebi: oi\ntudo bem\?\npreciso de ajuda/);
  });

  it('grava UMA resposta com replyToId = a última do lote e marca todas como respondidas', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa');
    const a = await accept(h, client, 'um');
    await accept(h, client, 'dois');
    const c = await accept(h, client, 'tres');

    const result = await h.service.respondToPending(client.id, 'contato-1', LIMITS);

    const stored = h.store.allMessages();
    const replies = stored.filter((message) => message.role === 'ASSISTANT');
    assert.equal(replies.length, 1);
    const [reply] = replies;
    assert.ok(reply !== undefined);
    assert.equal(reply.id, result.reply?.id);
    assert.equal(reply.replyToId, c.messageId, 'a unicidade (cliente, replyToId) segue valendo');
    assert.equal(reply.isFallback, false);
    const users = stored.filter((message) => message.role === 'USER');
    assert.equal(users.length, 3);
    for (const user of users) assert.equal(user.answeredById, reply.id);
    // A resposta fica logo depois da última do lote, na ordem da conversa.
    const order = sorted(stored).map((message) => message.id);
    assert.equal(order.at(-1), reply.id);
    assert.equal(order[0], a.messageId);
    assert.deepEqual(h.metrics.batches, [{ size: 3, result: 'answered' }]);
  });

  it('uma segunda chamada não encontra pendentes e não chama o LLM de novo (empty)', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa');
    await accept(h, client, 'oi');
    await h.service.respondToPending(client.id, 'contato-1', LIMITS);
    // Marca a resposta como enviada para que não seja um `resend`.
    const reply = h.store.allMessages().find((message) => message.role === 'ASSISTANT');
    assert.ok(reply !== undefined);
    await h.store.messages.markSent(client.id, reply.id, {
      channelMessageId: 'wamid.out',
      sentAt: new Date(),
    });

    const again = await h.service.respondToPending(client.id, 'contato-1', LIMITS);

    assert.equal(again.outcome, 'empty');
    assert.equal(again.reply, null);
    assert.equal(again.batchSize, 0);
    assert.equal(h.llm.calls.length, 1);
    assert.equal(h.store.allMessages().filter((message) => message.role === 'ASSISTANT').length, 1);
    assert.deepEqual(h.metrics.batches.at(-1), { size: 0, result: 'empty' });
  });

  it('contato sem conversa: empty, sem criar nada', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa');
    const result = await h.service.respondToPending(client.id, 'ninguem', LIMITS);
    assert.equal(result.outcome, 'empty');
    assert.equal(h.store.allConversations().length, 0);
  });

  it('mais pendentes que o limite de mensagens: turnos sucessivos, sem perder nenhuma e na ordem', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa');
    for (let i = 1; i <= 5; i += 1) await accept(h, client, `m${String(i)}`);
    const limits = { maxMessages: 2, maxChars: 8_000 };

    const turns = [];
    for (let i = 0; i < 3; i += 1) {
      turns.push(await h.service.respondToPending(client.id, 'contato-1', limits));
    }

    assert.deepEqual(
      turns.map((turn) => [turn.batchSize, turn.hasMorePending]),
      [
        [2, true],
        [2, true],
        [1, false],
      ],
    );
    assert.deepEqual(
      h.llm.calls.map((call) => call.userMessage),
      ['m1\nm2', 'm3\nm4', 'm5'],
    );
    const users = h.store.allMessages().filter((message) => message.role === 'USER');
    assert.ok(
      users.every((user) => user.answeredById !== null),
      'nenhuma mensagem perdida',
    );
    assert.deepEqual(
      // Os turnos não são enviados neste teste: cada um avisa que o anterior ficou sem `sentAt`.
      h.metrics.batches.map((batch) => batch.result).filter((r) => r !== 'unsent_previous'),
      ['capped', 'capped', 'answered'],
    );
    // O histórico de cada turno inclui o turno anterior (mensagens e a resposta, na ordem).
    assert.deepEqual(
      h.llm.calls.map((call) => call.history.map((turn) => turn.role)),
      [
        [],
        ['user', 'user', 'assistant'],
        ['user', 'user', 'assistant', 'user', 'user', 'assistant'],
      ],
    );
  });

  it('o limite de caracteres corta o lote; uma única mensagem maior que o limite segue sozinha', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa');
    await accept(h, client, 'a'.repeat(10));
    await accept(h, client, 'b'.repeat(10));
    await accept(h, client, 'c'.repeat(10));
    await accept(h, client, 'd'.repeat(50));
    await accept(h, client, 'e'.repeat(5));
    // 10 + 1 + 10 = 21 cabe em 25; a terceira (21 + 11 = 32) vira o turno seguinte.
    const limits = { maxMessages: 10, maxChars: 25 };

    const sizes = [];
    for (let i = 0; i < 4; i += 1) {
      const turn = await h.service.respondToPending(client.id, 'contato-1', limits);
      sizes.push(turn.batchSize);
      if (!turn.hasMorePending) break;
    }

    assert.deepEqual(sizes, [2, 1, 1, 1]);
    assert.deepEqual(
      h.llm.calls.map((call) => call.userMessage.length),
      [21, 10, 50, 5],
    );
  });

  it('mensagem que chega durante a chamada ao LLM não entra no lote em andamento e recebe a sua própria resposta, com a primeira no histórico', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa');
    await accept(h, client, 'primeira');
    const release = h.llm.hold();

    const running = h.service.respondToPending(client.id, 'contato-1', LIMITS);
    // Espera a chamada ao LLM começar e então chega uma mensagem nova.
    while (h.llm.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    await accept(h, client, 'chegou durante');
    release();
    const first = await running;

    assert.equal(first.batchSize, 1);
    assert.deepEqual(h.llm.calls[0]?.userMessage, 'primeira');
    const second = await h.service.respondToPending(client.id, 'contato-1', LIMITS);
    assert.equal(second.batchSize, 1);
    assert.equal(h.llm.calls[1]?.userMessage, 'chegou durante');
    assert.deepEqual(
      h.llm.calls[1].history.map((turn) => [turn.role, turn.content.slice(0, 16)]),
      [
        ['user', 'primeira'],
        ['assistant', '[mock] Recebi: p'],
      ],
      'o turno seguinte enxerga a resposta anterior antes da mensagem nova',
    );
    const users = h.store.allMessages().filter((message) => message.role === 'USER');
    assert.ok(users.every((user) => user.answeredById !== null));
  });

  it('a chamada ao LLM fica fora de qualquer transação', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa');
    await accept(h, client, 'oi');
    let openDuringCall = -1;
    const generate = h.llm.generate.bind(h.llm);
    h.llm.generate = (input) => {
      openDuringCall = h.store.openTransactions;
      return generate(input);
    };

    await h.service.respondToPending(client.id, 'contato-1', LIMITS);

    assert.equal(openDuringCall, 0);
  });

  it('falha do LLM no lote grava um fallback que marca todas as mensagens do lote', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa');
    await accept(h, client, 'um');
    await accept(h, client, `${MOCK_FAIL_MARKER} dois`);

    const result = await h.service.respondToPending(client.id, 'contato-1', LIMITS);

    assert.equal(result.reply?.isFallback, true);
    assert.equal(result.reply.text, ATTENDANCE_FALLBACK_TEXT);
    assert.equal(result.batchSize, 2);
    const stored = h.store.allMessages();
    assert.equal(stored.filter((message) => message.role === 'ASSISTANT').length, 1);
    assert.ok(
      stored
        .filter((message) => message.role === 'USER')
        .every((user) => user.answeredById !== null),
    );
    assert.equal(h.metrics.fallbacks, 1);
  });

  it('se marcar as mensagens falha, a resposta também é desfeita (mesma transação) e o lote segue pendente', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa');
    await accept(h, client, 'um');
    await accept(h, client, 'dois');
    const real = h.store.messages.markAnswered.bind(h.store.messages);
    h.store.messages.markAnswered = () => Promise.reject(new Error('queda simulada'));

    await assert.rejects(h.service.respondToPending(client.id, 'contato-1', LIMITS), /queda/);

    assert.equal(
      h.store.allMessages().filter((message) => message.role === 'ASSISTANT').length,
      0,
      'a resposta não sobrou sozinha',
    );
    h.store.messages.markAnswered = real;
    const retry = await h.service.respondToPending(client.id, 'contato-1', LIMITS);
    assert.equal(retry.batchSize, 2);
    assert.equal(h.store.allMessages().filter((message) => message.role === 'ASSISTANT').length, 1);
  });

  it('duas execuções simultâneas para o mesmo contato nunca duplicam a resposta', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa');
    await accept(h, client, 'um');
    await accept(h, client, 'dois');

    const [left, right] = await Promise.all([
      h.service.respondToPending(client.id, 'contato-1', LIMITS),
      h.service.respondToPending(client.id, 'contato-1', LIMITS),
    ]);

    assert.equal(h.store.allMessages().filter((message) => message.role === 'ASSISTANT').length, 1);
    assert.equal(left.reply?.id, right.reply?.id, 'as duas enxergam a mesma resposta');
    // O lote é contado uma vez (quem respondeu primeiro), não uma vez por execução.
    assert.deepEqual(h.metrics.batches, [{ size: 2, result: 'answered' }]);
  });

  it('lotes diferentes do mesmo contato em paralelo: se outra execução já respondeu parte do lote, esta resposta é desfeita (ConflictError) e a retentativa resolve', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa');
    const m1 = await accept(h, client, 'um');
    await accept(h, client, 'dois');
    // Simula a outra execução: ela já respondeu `m1` (resposta própria, já confirmada) entre a
    // leitura das pendentes e a transação desta execução (durante a chamada ao LLM).
    const generate = h.llm.generate.bind(h.llm);
    let interfered = false;
    h.llm.generate = async (input) => {
      if (!interfered) {
        interfered = true;
        const other = await h.store.messages.create(client.id, {
          conversationId: m1.conversationId,
          role: 'ASSISTANT',
          content: 'resposta da outra execução',
          replyToId: m1.messageId,
          createdAt: new Date(m1.messageCreatedAt.getTime() + 1),
        });
        await h.store.messages.markAnswered(client.id, [m1.messageId], other.id);
      }
      return generate(input);
    };

    await assert.rejects(h.service.respondToPending(client.id, 'contato-1', LIMITS), ConflictError);

    const replies = h.store.allMessages().filter((message) => message.role === 'ASSISTANT');
    assert.equal(replies.length, 1, 'só a da outra execução: esta foi desfeita');
    assert.equal(replies[0]?.content, 'resposta da outra execução');
    // A retentativa responde o que sobrou, sem duplicar o que já tinha dono.
    const retry = await h.service.respondToPending(client.id, 'contato-1', LIMITS);
    assert.equal(retry.batchSize, 1);
    assert.equal(h.llm.calls.at(-1)?.userMessage, 'dois');
    assert.equal(h.store.allMessages().filter((m) => m.role === 'ASSISTANT').length, 2);
    assert.ok(
      h.store
        .allMessages()
        .filter((m) => m.role === 'USER')
        .every((m) => m.answeredById !== null),
    );
  });

  it('resposta gravada e ainda não enviada: resend, sem nova chamada ao LLM; depois do sentAt, empty', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa');
    await accept(h, client, 'oi');
    const answered = await h.service.respondToPending(client.id, 'contato-1', LIMITS);
    assert.equal(answered.reply?.sentAt, null);
    const llmCalls = h.llm.calls.length;

    const resend = await h.service.respondToPending(client.id, 'contato-1', LIMITS);
    assert.equal(resend.outcome, 'resend');
    assert.equal(resend.reply?.id, answered.reply.id);
    assert.equal(resend.batchSize, 0);
    assert.equal(h.llm.calls.length, llmCalls);

    await h.store.messages.markSent(client.id, answered.reply.id, {
      channelMessageId: 'wamid.out',
      sentAt: new Date(),
    });
    const done = await h.service.respondToPending(client.id, 'contato-1', LIMITS);
    assert.equal(done.outcome, 'empty');
  });

  it('retentativa (resumeUnsent) com pendentes depois de uma resposta não enviada: reenvia a resposta primeiro e avisa que há mais', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa');
    await accept(h, client, 'um');
    const first = await h.service.respondToPending(client.id, 'contato-1', LIMITS);
    await accept(h, client, 'dois');
    const llmCalls = h.llm.calls.length;

    const resumed = await h.service.respondToPending(client.id, 'contato-1', LIMITS, {
      resumeUnsent: true,
    });

    assert.equal(resumed.outcome, 'resend');
    assert.equal(resumed.reply?.id, first.reply?.id);
    assert.equal(resumed.hasMorePending, true);
    assert.equal(h.llm.calls.length, llmCalls, 'sem nova chamada ao LLM');

    // Sem a opção (primeira tentativa), a resposta anterior não é reenviada: responde as pendentes,
    // avisa em log (só ids) e conta o evento.
    const normal = await h.service.respondToPending(client.id, 'contato-1', LIMITS);
    assert.equal(normal.outcome, 'answered');
    assert.equal(normal.batchSize, 1);
    const warn = h.logs
      .lines()
      .find((line) => String(line.msg).includes('não foi enviada e não será reenviada'));
    assert.equal(warn?.level, 40);
    assert.equal(warn.clientId, client.id);
    assert.equal(warn.replyId, first.reply?.id);
    assert.ok(!h.logs.raw().includes('um'.repeat(10)), 'sem texto no aviso');
    assert.deepEqual(
      h.metrics.batches.map((batch) => batch.result),
      ['answered', 'unsent_previous', 'answered'],
    );
  });

  it('não avisa quando a resposta anterior já foi enviada', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa');
    await accept(h, client, 'um');
    const first = await h.service.respondToPending(client.id, 'contato-1', LIMITS);
    await h.store.messages.markSent(client.id, first.reply?.id ?? '', {
      channelMessageId: 'wamid.out',
      sentAt: new Date(),
    });
    await accept(h, client, 'dois');
    await h.service.respondToPending(client.id, 'contato-1', LIMITS);
    assert.ok(!h.logs.raw().includes('não será reenviada'));
    assert.ok(h.metrics.batches.every((batch) => batch.result !== 'unsent_previous'));
  });

  it('resumeUnsent não reenvia resposta que já tem sentAt', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa');
    await accept(h, client, 'um');
    const first = await h.service.respondToPending(client.id, 'contato-1', LIMITS);
    await h.store.messages.markSent(client.id, first.reply?.id ?? '', {
      channelMessageId: 'wamid.out',
      sentAt: new Date(),
    });
    await accept(h, client, 'dois');

    const resumed = await h.service.respondToPending(client.id, 'contato-1', LIMITS, {
      resumeUnsent: true,
    });

    assert.equal(resumed.outcome, 'answered');
    assert.equal(resumed.batchSize, 1);
  });

  it('cliente suspenso (403) e removido (404): nada é respondido', async () => {
    const h = setup();
    const suspended = await newClient(h, 'alfa');
    await accept(h, suspended, 'oi');
    await h.clients.update(suspended.id, { status: 'SUSPENDED' });
    await assert.rejects(
      h.service.respondToPending(suspended.id, 'contato-1', LIMITS),
      ForbiddenError,
    );
    const removed = await newClient(h, 'beta');
    await h.clients.delete(removed.id);
    await assert.rejects(
      h.service.respondToPending(removed.id, 'contato-1', LIMITS),
      NotFoundError,
    );
    assert.equal(h.llm.calls.length, 0);
    assert.equal(h.store.allMessages().filter((message) => message.role === 'ASSISTANT').length, 0);
  });

  it('limites inválidos são recusados (Zod)', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa');
    await assert.rejects(
      h.service.respondToPending(client.id, 'c', { maxMessages: 0, maxChars: 10 }),
      ZodError,
    );
    await assert.rejects(
      h.service.respondToPending(client.id, 'c', { maxMessages: 1, maxChars: 0 }),
      ZodError,
    );
  });

  it('hasPendingMessages reflete o que espera resposta', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa');
    assert.equal(await h.service.hasPendingMessages(client.id, 'contato-1'), false);
    await accept(h, client, 'oi');
    assert.equal(await h.service.hasPendingMessages(client.id, 'contato-1'), true);
    await h.service.respondToPending(client.id, 'contato-1', LIMITS);
    assert.equal(await h.service.hasPendingMessages(client.id, 'contato-1'), false);
  });
});

describe('isolamento entre clientes no agrupamento (spec 013)', () => {
  it('o mesmo contactRef em dois clientes nunca se mistura: lotes, histórico e persona de cada um', async () => {
    const h = setup();
    const a = await newClient(h, 'alfa', `${PERSONA}-A`);
    const b = await newClient(h, 'beta', `${PERSONA}-B`);
    // Intercalado: mesmas pessoas (contactRef), clientes diferentes.
    await accept(h, a, 'a-um');
    await accept(h, b, 'b-um');
    await accept(h, a, 'a-dois');
    await accept(h, b, 'b-dois');
    await accept(h, b, 'b-tres');

    const resultA = await h.service.respondToPending(a.id, 'contato-1', LIMITS);
    const resultB = await h.service.respondToPending(b.id, 'contato-1', LIMITS);

    assert.equal(resultA.batchSize, 2);
    assert.equal(resultB.batchSize, 3);
    assert.equal(h.llm.calls[0]?.userMessage, 'a-um\na-dois');
    assert.equal(h.llm.calls[1]?.userMessage, 'b-um\nb-dois\nb-tres');
    assert.match(h.llm.calls[0].systemPrompt, /-A/);
    assert.match(h.llm.calls[1].systemPrompt, /-B/);
    assert.deepEqual(h.llm.calls[0].history, []);
    assert.deepEqual(h.llm.calls[1].history, []);
    const stored = h.store.allMessages();
    for (const client of [a, b]) {
      const own = stored.filter((message) => message.clientId === client.id);
      const replies = own.filter((message) => message.role === 'ASSISTANT');
      assert.equal(replies.length, 1);
      assert.ok(
        own
          .filter((message) => message.role === 'USER')
          .every((message) => message.answeredById === replies[0]?.id),
      );
    }
  });

  it('dois contatos do mesmo cliente nunca se misturam', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa');
    await accept(h, client, 'x1', 'contato-x');
    await accept(h, client, 'y1', 'contato-y');
    await accept(h, client, 'x2', 'contato-x');
    await accept(h, client, 'y2', 'contato-y');

    await h.service.respondToPending(client.id, 'contato-x', LIMITS);
    // O lote de X não encosta nas mensagens de Y.
    assert.equal(await h.service.hasPendingMessages(client.id, 'contato-y'), true);
    await h.service.respondToPending(client.id, 'contato-y', LIMITS);

    assert.deepEqual(
      h.llm.calls.map((call) => call.userMessage),
      ['x1\nx2', 'y1\ny2'],
    );
  });
});

describe('privacidade no agrupamento (spec 013)', () => {
  it('texto, persona e contato não aparecem em log nem em métrica (aceitar, responder, falhar)', async () => {
    const h = setup();
    const client = await newClient(h, 'alfa');
    await accept(h, client, SECRET_TEXT, 'contato-secreto-b13');
    await accept(h, client, `${MOCK_FAIL_MARKER} ${SECRET_TEXT}`, 'contato-secreto-b13');
    await h.service.respondToPending(client.id, 'contato-secreto-b13', LIMITS);
    await accept(h, client, `outra ${SECRET_TEXT}`, 'contato-secreto-b13');
    const raw = h.logs.raw();
    for (const secret of [SECRET_TEXT, PERSONA, 'contato-secreto-b13']) {
      assert.ok(!raw.includes(secret), `vazou em log: ${secret}`);
    }
    assert.ok(raw.includes('mensagem do contato aceita'));
    assert.ok(raw.includes('lote de mensagens atendido'));
    assert.deepEqual(h.metrics.batches, [{ size: 2, result: 'answered' }]);
  });
});
