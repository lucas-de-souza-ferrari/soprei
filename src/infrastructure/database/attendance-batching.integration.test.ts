import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ConflictError } from '../../shared/errors/index.js';
import { AttendanceService } from '../../application/attendance/attendance.service.js';
import type { BatchLimits } from '../../application/attendance/attendance.schemas.js';
import { MockLlmProvider } from '../external-apis/llm/mock-llm.provider.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import { createDatabase, type Database } from './database.js';
import { PrismaAttendanceUnitOfWork } from './repositories/attendance-unit-of-work.js';
import { PrismaClientRepository } from './repositories/client.repository.js';
import { PrismaConversationRepository } from './repositories/conversation.repository.js';
import { PrismaMessageRepository } from './repositories/message.repository.js';

const config = loadIntegrationConfig();
const LIMITS: BatchLimits = { maxMessages: 10, maxChars: 8_000 };

let database: Database;
let tenants: TestTenants;
let llm: MockLlmProvider;
let service: AttendanceService;
let messages: PrismaMessageRepository;
let conversations: PrismaConversationRepository;

before(() => {
  database = createDatabase(config, captureLogs('silent').logger);
  tenants = new TestTenants(database.prisma);
  messages = new PrismaMessageRepository(database.prisma);
  conversations = new PrismaConversationRepository(database.prisma);
  llm = new MockLlmProvider({ recordCalls: true });
  service = new AttendanceService({
    clients: new PrismaClientRepository(database.prisma),
    conversations,
    messages,
    unitOfWork: new PrismaAttendanceUnitOfWork(database.prisma),
    llm,
    logger: captureLogs('silent').logger,
    options: { llmTimeoutMs: 1_000, inFlightTimeoutMs: 60_000 },
  });
});

after(async () => {
  try {
    await tenants.cleanup();
  } finally {
    await database.close();
  }
});

const accept = (
  clientId: Parameters<typeof service.acceptInboundMessage>[0],
  text: string,
  contact: string,
  id: string,
) => service.acceptInboundMessage(clientId, { contactRef: contact, text, externalId: id });

describe('agrupamento no banco (spec 013)', () => {
  it('o lote fica com answeredById = a resposta, replyToId = a última mensagem, e a segunda chamada não acha pendentes', async () => {
    const client = await tenants.createClient('lote-db');
    const contact = 'contato-lote';
    for (const [i, text] of ['um', 'dois', 'tres'].entries()) {
      await accept(client.id, text, contact, `ext-${String(i)}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    llm.calls.length = 0;

    const first = await service.respondToPending(client.id, contact, LIMITS);

    assert.equal(first.outcome, 'answered');
    assert.equal(first.batchSize, 3);
    assert.equal(llm.calls[0]?.userMessage, 'um\ndois\ntres');
    const conversation = await conversations.findByContact(client.id, contact);
    assert.ok(conversation !== null);
    const rows = await database.prisma.message.findMany({
      where: { clientId: client.id, conversationId: conversation.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const reply = rows.find((row) => row.role === 'ASSISTANT');
    assert.ok(reply !== undefined);
    const users = rows.filter((row) => row.role === 'USER');
    assert.ok(users.every((user) => user.answeredById === reply.id));
    assert.equal(reply.replyToId, users[2]?.id);
    assert.equal(rows.at(-1)?.id, reply.id, 'a resposta fica depois da última mensagem do lote');

    // Segunda chamada: sem pendentes. A resposta ainda não foi enviada: só reenvio, sem novo LLM.
    const second = await service.respondToPending(client.id, contact, LIMITS);
    assert.equal(second.outcome, 'resend');
    assert.equal(llm.calls.length, 1);
    await messages.markSent(client.id, reply.id, {
      channelMessageId: 'wamid.out',
      sentAt: new Date(),
    });
    const third = await service.respondToPending(client.id, contact, LIMITS);
    assert.equal(third.outcome, 'empty');
    assert.equal(llm.calls.length, 1);
  });

  it('o mesmo contato em dois clientes: cada um com o seu lote, e a resposta de um nunca marca mensagem do outro', async () => {
    const a = await tenants.createClient('iso-db-a');
    const b = await tenants.createClient('iso-db-b');
    const contact = 'contato-igual';
    await accept(a.id, 'a1', contact, 'x1');
    await accept(b.id, 'b1', contact, 'x1');
    await accept(a.id, 'a2', contact, 'x2');
    llm.calls.length = 0;

    await service.respondToPending(a.id, contact, LIMITS);

    assert.equal(llm.calls[0]?.userMessage, 'a1\na2');
    // B segue pendente.
    assert.equal(await service.hasPendingMessages(b.id, contact), true);
    assert.equal(await service.hasPendingMessages(a.id, contact), false);
    await service.respondToPending(b.id, contact, LIMITS);
    assert.equal(llm.calls[1]?.userMessage, 'b1');
    assert.deepEqual(llm.calls[1].history, []);
  });

  it('duas execuções simultâneas para o mesmo contato nunca duplicam a resposta', async () => {
    const client = await tenants.createClient('corrida-db');
    const contact = 'contato-corrida';
    await accept(client.id, 'um', contact, 'e1');
    await accept(client.id, 'dois', contact, 'e2');

    await Promise.all([
      service.respondToPending(client.id, contact, LIMITS),
      service.respondToPending(client.id, contact, LIMITS),
    ]);

    const conversation = await conversations.findByContact(client.id, contact);
    assert.ok(conversation !== null);
    const replies = await database.prisma.message.count({
      where: { clientId: client.id, conversationId: conversation.id, role: 'ASSISTANT' },
    });
    assert.equal(replies, 1);
  });

  it('reentrega de mensagem já respondida (mesmo externalId) não grava nem responde de novo', async () => {
    const client = await tenants.createClient('reentrega-db');
    const contact = 'contato-reentrega';
    await accept(client.id, 'oi', contact, 'dup');
    await service.respondToPending(client.id, contact, LIMITS);
    const before = llm.calls.length;

    const again = await accept(client.id, 'oi', contact, 'dup');

    assert.equal(again.status, 'answered');
    assert.equal(llm.calls.length, before);
    assert.equal(await database.prisma.message.count({ where: { clientId: client.id } }), 2);
  });

  it('lotes diferentes do mesmo contato em paralelo: só uma resposta confirma, a outra é desfeita (ConflictError) e a retentativa nunca deixa duas respostas para a mesma mensagem', async () => {
    const client = await tenants.createClient('lotes-paralelos-db');
    const contact = 'contato-paralelo';
    for (const [i, text] of ['um', 'dois', 'tres'].entries()) {
      await accept(client.id, text, contact, `par-${String(i)}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    llm.calls.length = 0;
    const release = llm.hold();

    // As duas execuções leem as três pendentes e escolhem lotes diferentes (2 e 3 mensagens).
    const small = service.respondToPending(client.id, contact, { maxMessages: 2, maxChars: 8_000 });
    const large = service.respondToPending(client.id, contact, LIMITS);
    const settled = Promise.allSettled([small, large]);
    while (llm.calls.length < 2) await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    const results = await settled;

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'só uma execução confirma');
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0]?.reason instanceof ConflictError);

    // Retentativa da que perdeu: responde o que sobrou (ou nada), sem duplicar mensagem alguma.
    await service.respondToPending(client.id, contact, LIMITS);
    const conversation = await conversations.findByContact(client.id, contact);
    assert.ok(conversation !== null);
    const rows = await database.prisma.message.findMany({
      where: { clientId: client.id, conversationId: conversation.id },
    });
    const users = rows.filter((row) => row.role === 'USER');
    const replies = rows.filter((row) => row.role === 'ASSISTANT');
    assert.ok(
      users.every((user) => user.answeredById !== null),
      'nenhuma mensagem sem resposta',
    );
    const owners = new Set(users.map((user) => user.answeredById));
    assert.equal(replies.length, owners.size, 'toda resposta atende pelo menos uma mensagem');
    assert.ok(replies.every((reply) => owners.has(reply.id)));
    assert.ok(replies.length <= 2);
  });
});
