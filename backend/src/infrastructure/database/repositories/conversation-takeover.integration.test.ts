import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Company } from '../../../domain/index.js';
import { loadIntegrationConfig } from '../../../test-support/integration-env.js';
import { TestTenants } from '../../../test-support/tenant-fixtures.js';
import { createLogger } from '../../logger/logger.js';
import { createDatabase, type Database } from '../database.js';
import { PrismaConversationRepository } from './conversation.repository.js';
import { PrismaMessageRepository } from './message.repository.js';

// Spec 039: pausa da IA, mensagens HUMAN e o filtro das pendentes no Postgres real, com isolamento A x B.
const config = loadIntegrationConfig();
const T0 = new Date('2026-11-12T12:00:00.000Z');
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1_000);

let database: Database;
let tenants: TestTenants;
let conversations: PrismaConversationRepository;
let messages: PrismaMessageRepository;
let companyA: Company;
let companyB: Company;
let counter = 0;
const nextRef = (): string => `5511900${String((counter += 1)).padStart(6, '0')}`;

before(async () => {
  database = createDatabase(config, createLogger(config));
  tenants = new TestTenants(database.prisma);
  conversations = new PrismaConversationRepository(database.prisma);
  messages = new PrismaMessageRepository(database.prisma);
  companyA = await tenants.createCompany('coex-a');
  companyB = await tenants.createCompany('coex-b');
});

after(async () => {
  try {
    await tenants.cleanup();
  } finally {
    await database.close();
  }
});

async function conversationWith(company: Company, contactRef = nextRef()) {
  return conversations.findOrCreateByContact(company.id, contactRef);
}

describe('pausa da IA na conversa (spec 039)', () => {
  it('extendAiPause só avança cada campo; clearAiPause zera só a pausa', async () => {
    const conversation = await conversationWith(companyA);
    await conversations.extendAiPause(companyA.id, conversation.id, {
      pausedUntil: at(100),
      ignoreBefore: at(10),
    });
    await conversations.extendAiPause(companyA.id, conversation.id, {
      pausedUntil: at(50),
      ignoreBefore: at(5),
    });
    let row = await conversations.findById(companyA.id, conversation.id);
    assert.equal(row.aiPausedUntil?.getTime(), at(100).getTime(), 'nunca encurta');
    assert.equal(row.aiIgnoreBefore?.getTime(), at(10).getTime(), 'nunca volta');

    await conversations.extendAiPause(companyA.id, conversation.id, { pausedUntil: at(200) });
    row = await conversations.findById(companyA.id, conversation.id);
    assert.equal(row.aiPausedUntil?.getTime(), at(200).getTime());

    assert.equal(await conversations.clearAiPause(companyA.id, conversation.id), true);
    row = await conversations.findById(companyA.id, conversation.id);
    assert.equal(row.aiPausedUntil, null);
    assert.equal(row.aiIgnoreBefore?.getTime(), at(10).getTime(), 'aiIgnoreBefore mantido');
  });

  it('isolamento: a empresa B não pausa nem reativa a conversa da A', async () => {
    const conversation = await conversationWith(companyA);
    await conversations.extendAiPause(companyB.id, conversation.id, {
      pausedUntil: at(999),
      ignoreBefore: at(999),
    });
    let row = await conversations.findById(companyA.id, conversation.id);
    assert.equal(row.aiPausedUntil, null);
    assert.equal(row.aiIgnoreBefore, null);

    await conversations.extendAiPause(companyA.id, conversation.id, { pausedUntil: at(999) });
    assert.equal(await conversations.clearAiPause(companyB.id, conversation.id), false);
    row = await conversations.findById(companyA.id, conversation.id);
    assert.equal(row.aiPausedUntil?.getTime(), at(999).getTime());
    assert.equal(await conversations.clearAiPause(companyA.id, 'nao-e-uuid'), false);
  });

  it('listPending ignora o que a equipe já tratou (createdAt <= aiIgnoreBefore); grava HUMAN', async () => {
    const conversation = await conversationWith(companyA);
    const before = await messages.create(companyA.id, {
      conversationId: conversation.id,
      role: 'USER',
      content: 'antes',
      createdAt: at(1),
    });
    const human = await messages.create(companyA.id, {
      conversationId: conversation.id,
      role: 'HUMAN',
      content: 'equipe',
      externalId: `wamid.eco.${String(counter)}`,
      createdAt: at(2),
    });
    const afterEcho = await messages.create(companyA.id, {
      conversationId: conversation.id,
      role: 'USER',
      content: 'depois',
      createdAt: at(3),
    });
    assert.equal(human.role, 'HUMAN');
    assert.deepEqual(
      (await messages.listPending(companyA.id, conversation.id, 10)).map((m) => m.id),
      [before.id, afterEcho.id],
    );

    await conversations.extendAiPause(companyA.id, conversation.id, { ignoreBefore: at(2) });
    assert.deepEqual(
      (await messages.listPending(companyA.id, conversation.id, 10)).map((m) => m.id),
      [afterEcho.id],
    );
    // Conversa de outra empresa não tem pendentes por aqui.
    assert.deepEqual(await messages.listPending(companyB.id, conversation.id, 10), []);
    // A HUMAN entra no histórico (lado da empresa).
    const history = await messages.listBefore(companyA.id, conversation.id, afterEcho.id, 10);
    assert.deepEqual(
      history.map((m) => m.role),
      ['USER', 'HUMAN'],
    );
  });

  it('findByChannelMessageId acha só a resposta da própria empresa', async () => {
    const conversation = await conversationWith(companyA);
    const question = await messages.create(companyA.id, {
      conversationId: conversation.id,
      role: 'USER',
      content: 'pergunta',
    });
    const reply = await messages.create(companyA.id, {
      conversationId: conversation.id,
      role: 'ASSISTANT',
      content: 'resposta',
      replyToId: question.id,
    });
    const channelMessageId = `wamid.SENT.${String(counter)}`;
    await messages.markSent(companyA.id, reply.id, { channelMessageId, sentAt: at(5) });

    assert.equal(
      (await messages.findByChannelMessageId(companyA.id, channelMessageId))?.id,
      reply.id,
    );
    assert.equal(await messages.findByChannelMessageId(companyB.id, channelMessageId), null);
    assert.equal(await messages.findByChannelMessageId(companyA.id, 'wamid.outro'), null);
  });
});
