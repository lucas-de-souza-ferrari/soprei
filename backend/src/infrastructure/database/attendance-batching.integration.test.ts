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
import { PrismaCompanyRepository } from './repositories/company.repository.js';
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
    companies: new PrismaCompanyRepository(database.prisma),
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
  companyId: Parameters<typeof service.acceptInboundMessage>[0],
  text: string,
  contact: string,
  id: string,
) => service.acceptInboundMessage(companyId, { contactRef: contact, text, externalId: id });

describe('agrupamento no banco (spec 013)', () => {
  it('o lote fica com answeredById = a resposta, replyToId = a última mensagem, e a segunda chamada não acha pendentes', async () => {
    const company = await tenants.createCompany('lote-db');
    const contact = 'contato-lote';
    for (const [i, text] of ['um', 'dois', 'tres'].entries()) {
      await accept(company.id, text, contact, `ext-${String(i)}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    llm.calls.length = 0;

    const first = await service.respondToPending(company.id, contact, LIMITS);

    assert.equal(first.outcome, 'answered');
    assert.equal(first.batchSize, 3);
    assert.equal(llm.calls[0]?.userMessage, 'um\ndois\ntres');
    const conversation = await conversations.findByContact(company.id, contact);
    assert.ok(conversation !== null);
    const rows = await database.prisma.message.findMany({
      where: { companyId: company.id, conversationId: conversation.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const reply = rows.find((row) => row.role === 'ASSISTANT');
    assert.ok(reply !== undefined);
    const contactMessages = rows.filter((row) => row.role === 'USER');
    assert.ok(contactMessages.every((user) => user.answeredById === reply.id));
    assert.equal(reply.replyToId, contactMessages[2]?.id);
    assert.equal(rows.at(-1)?.id, reply.id, 'a resposta fica depois da última mensagem do lote');

    // Segunda chamada: sem pendentes. A resposta ainda não foi enviada: só reenvio, sem novo LLM.
    const second = await service.respondToPending(company.id, contact, LIMITS);
    assert.equal(second.outcome, 'resend');
    assert.equal(llm.calls.length, 1);
    await messages.markSent(company.id, reply.id, {
      channelMessageId: 'wamid.out',
      sentAt: new Date(),
    });
    const third = await service.respondToPending(company.id, contact, LIMITS);
    assert.equal(third.outcome, 'empty');
    assert.equal(llm.calls.length, 1);
  });

  it('o mesmo contato em duas empresas: cada um com o seu lote, e a resposta de um nunca marca mensagem do outro', async () => {
    const a = await tenants.createCompany('iso-db-a');
    const b = await tenants.createCompany('iso-db-b');
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
    const company = await tenants.createCompany('corrida-db');
    const contact = 'contato-corrida';
    await accept(company.id, 'um', contact, 'e1');
    await accept(company.id, 'dois', contact, 'e2');

    await Promise.all([
      service.respondToPending(company.id, contact, LIMITS),
      service.respondToPending(company.id, contact, LIMITS),
    ]);

    const conversation = await conversations.findByContact(company.id, contact);
    assert.ok(conversation !== null);
    const replies = await database.prisma.message.count({
      where: { companyId: company.id, conversationId: conversation.id, role: 'ASSISTANT' },
    });
    assert.equal(replies, 1);
  });

  it('reentrega de mensagem já respondida (mesmo externalId) não grava nem responde de novo', async () => {
    const company = await tenants.createCompany('reentrega-db');
    const contact = 'contato-reentrega';
    await accept(company.id, 'oi', contact, 'dup');
    await service.respondToPending(company.id, contact, LIMITS);
    const before = llm.calls.length;

    const again = await accept(company.id, 'oi', contact, 'dup');

    assert.equal(again.status, 'answered');
    assert.equal(llm.calls.length, before);
    assert.equal(await database.prisma.message.count({ where: { companyId: company.id } }), 2);
  });

  it('lotes diferentes do mesmo contato em paralelo: só uma resposta confirma, a outra é desfeita (ConflictError) e a retentativa nunca deixa duas respostas para a mesma mensagem', async () => {
    const company = await tenants.createCompany('lotes-paralelos-db');
    const contact = 'contato-paralelo';
    for (const [i, text] of ['um', 'dois', 'tres'].entries()) {
      await accept(company.id, text, contact, `par-${String(i)}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    llm.calls.length = 0;
    const release = llm.hold();

    // As duas execuções leem as três pendentes e escolhem lotes diferentes (2 e 3 mensagens).
    const small = service.respondToPending(company.id, contact, {
      maxMessages: 2,
      maxChars: 8_000,
    });
    const large = service.respondToPending(company.id, contact, LIMITS);
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
    await service.respondToPending(company.id, contact, LIMITS);
    const conversation = await conversations.findByContact(company.id, contact);
    assert.ok(conversation !== null);
    const rows = await database.prisma.message.findMany({
      where: { companyId: company.id, conversationId: conversation.id },
    });
    const contactMessages = rows.filter((row) => row.role === 'USER');
    const replies = rows.filter((row) => row.role === 'ASSISTANT');
    assert.ok(
      contactMessages.every((user) => user.answeredById !== null),
      'nenhuma mensagem sem resposta',
    );
    const owners = new Set(contactMessages.map((user) => user.answeredById));
    assert.equal(replies.length, owners.size, 'toda resposta atende pelo menos uma mensagem');
    assert.ok(replies.every((reply) => owners.has(reply.id)));
    assert.ok(replies.length <= 2);
  });
});

describe('última atividade da conversa pelos três caminhos de gravação (spec 024)', () => {
  const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

  it('handleInboundMessage, acceptInboundMessage e respondToPending levam o updatedAt à mensagem mais recente e reordenam a lista', async () => {
    const company = await tenants.createCompany('atividade-db');
    const order = async (): Promise<string[]> =>
      (await conversations.listByActivity(company.id)).items.map((item) => item.contactRef);
    const lastMessageAt = async (contact: string): Promise<number> => {
      const conversation = await conversations.findByContact(company.id, contact);
      assert.ok(conversation !== null);
      const rows = await database.prisma.message.findMany({
        where: { companyId: company.id, conversationId: conversation.id },
        orderBy: { createdAt: 'desc' },
        take: 1,
      });
      assert.equal(conversation.updatedAt.getTime(), rows[0]?.createdAt.getTime());
      return conversation.updatedAt.getTime();
    };

    // Simulador (handleInboundMessage): pergunta e resposta na mesma conversa.
    await service.handleInboundMessage(company.id, { contactRef: 'ativ-x', text: 'um' });
    await pause();
    await service.handleInboundMessage(company.id, { contactRef: 'ativ-y', text: 'dois' });
    assert.deepEqual(await order(), ['ativ-y', 'ativ-x']);
    await lastMessageAt('ativ-x');
    await lastMessageAt('ativ-y');

    await pause();
    await service.handleInboundMessage(company.id, { contactRef: 'ativ-x', text: 'tres' });
    assert.deepEqual(await order(), ['ativ-x', 'ativ-y']);

    // Canal: aceitar (só a mensagem do contato) já move a conversa.
    await pause();
    await accept(company.id, 'quatro', 'ativ-y', 'ativ-ext-1');
    assert.deepEqual(await order(), ['ativ-y', 'ativ-x']);
    const afterAccept = await lastMessageAt('ativ-y');

    // Responder: a resposta (última mensagem + 1 ms) leva o updatedAt até ela.
    await pause();
    await service.respondToPending(company.id, 'ativ-y', LIMITS);
    const afterReply = await lastMessageAt('ativ-y');
    assert.ok(afterReply > afterAccept);
    assert.deepEqual(await order(), ['ativ-y', 'ativ-x']);
  });
});

describe('instante de recebimento no banco (spec 034)', () => {
  /** Carimbos recentes (dentro da faixa aceita), com milissegundos distintos. */
  const receivedBase = (): number => Date.now() - 2_000;

  const acceptAt = (
    companyId: Parameters<typeof service.acceptInboundMessage>[0],
    text: string,
    contact: string,
    id: string,
    receivedAt?: Date,
  ) =>
    service.acceptInboundMessage(
      companyId,
      { contactRef: contact, text, externalId: id },
      receivedAt === undefined ? {} : { receivedAt },
    );

  const rowsOf = async (companyId: string, contact: string) => {
    const conversation = await conversations.findByContact(
      companyId as Parameters<typeof conversations.findByContact>[0],
      contact,
    );
    assert.ok(conversation !== null);
    return database.prisma.message.findMany({
      where: { companyId, conversationId: conversation.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  };

  it('grava createdAt = receivedAt; sem receivedAt vale o relógio do banco', async () => {
    const company = await tenants.createCompany('rec-db');
    const contact = 'contato-rec';
    const at = new Date(receivedBase());
    const before = Date.now();

    const stamped = await acceptAt(company.id, 'carimbada', contact, 'rec-1', at);
    const plain = await acceptAt(company.id, 'sem carimbo', contact, 'rec-2');

    assert.equal(stamped.messageCreatedAt.getTime(), at.getTime());
    // Relógio do banco: folga de 5 s para diferença entre o relógio do teste e o do Postgres.
    assert.ok(plain.messageCreatedAt.getTime() >= before - 5_000);
    const rows = await rowsOf(company.id, contact);
    assert.deepEqual(
      rows.map((row) => row.content),
      ['carimbada', 'sem carimbo'],
    );
    assert.equal(rows[0]?.createdAt.getTime(), at.getTime());
  });

  it('mensagens gravadas na ordem inversa à de recebimento: pendentes e turno do modelo na ordem de recebimento', async () => {
    const company = await tenants.createCompany('rec-ordem');
    const contact = 'contato-ordem';
    const base = receivedBase();
    // Jobs em paralelo: a terceira e a segunda são gravadas antes da primeira.
    await acceptAt(company.id, 'tres', contact, 'ord-3', new Date(base + 2));
    await acceptAt(company.id, 'dois', contact, 'ord-2', new Date(base + 1));
    await acceptAt(company.id, 'um', contact, 'ord-1', new Date(base));
    llm.calls.length = 0;

    const conversation = await conversations.findByContact(company.id, contact);
    assert.ok(conversation !== null);
    const pending = await messages.listPending(company.id, conversation.id, 10);
    assert.deepEqual(
      pending.map((message) => message.content),
      ['um', 'dois', 'tres'],
    );

    const response = await service.respondToPending(company.id, contact, LIMITS);

    assert.equal(response.outcome, 'answered');
    assert.equal(response.batchSize, 3);
    assert.equal(llm.calls[0]?.userMessage, 'um\ndois\ntres');
    const rows = await rowsOf(company.id, contact);
    assert.equal(rows.at(-1)?.role, 'ASSISTANT', 'a resposta fica depois da última do lote');
    assert.equal(rows.at(-1)?.createdAt.getTime(), base + 3);
  });

  it('reentrega do mesmo externalId com outro receivedAt não muda o createdAt gravado', async () => {
    const company = await tenants.createCompany('rec-dup');
    const contact = 'contato-dup';
    const base = receivedBase();
    const first = await acceptAt(company.id, 'oi', contact, 'dup-1', new Date(base));

    const again = await acceptAt(company.id, 'oi', contact, 'dup-1', new Date(base + 900));

    assert.equal(again.status, 'pending');
    assert.equal(again.messageId, first.messageId);
    assert.equal(again.messageCreatedAt.getTime(), base);
    assert.equal((await rowsOf(company.id, contact)).length, 1);
  });

  it('duas empresas com o mesmo contato e os mesmos instantes, gravadas em paralelo: cada lote só tem as suas mensagens', async () => {
    const a = await tenants.createCompany('rec-iso-a');
    const b = await tenants.createCompany('rec-iso-b');
    const contact = 'contato-paralelo';
    const base = receivedBase();
    await Promise.all([
      acceptAt(a.id, 'a2', contact, 'p2', new Date(base + 1)),
      acceptAt(b.id, 'b2', contact, 'p2', new Date(base + 1)),
      acceptAt(a.id, 'a1', contact, 'p1', new Date(base)),
      acceptAt(b.id, 'b1', contact, 'p1', new Date(base)),
    ]);
    llm.calls.length = 0;

    await Promise.all([
      service.respondToPending(a.id, contact, LIMITS),
      service.respondToPending(b.id, contact, LIMITS),
    ]);

    assert.deepEqual(llm.calls.map((call) => call.userMessage).sort(), ['a1\na2', 'b1\nb2']);
    for (const [company, own, foreign] of [
      [a, 'a', 'b'],
      [b, 'b', 'a'],
    ] as const) {
      const rows = await rowsOf(company.id, contact);
      const contactRows = rows.filter((row) => row.role === 'USER');
      assert.deepEqual(
        contactRows.map((row) => row.content),
        [`${own}1`, `${own}2`],
      );
      assert.ok(contactRows.every((row) => !row.content.startsWith(foreign)));
      const reply = rows.find((row) => row.role === 'ASSISTANT');
      assert.ok(reply !== undefined);
      assert.ok(contactRows.every((row) => row.answeredById === reply.id));
    }
  });
});
