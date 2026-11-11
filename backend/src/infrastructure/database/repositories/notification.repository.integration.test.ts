import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { Company, Conversation, Membership, Message } from '../../../domain/index.js';
import { NotFoundError, ValidationError } from '../../../shared/errors/index.js';
import { loadIntegrationConfig } from '../../../test-support/integration-env.js';
import { TestTenants } from '../../../test-support/tenant-fixtures.js';
import { createLogger } from '../../logger/logger.js';
import { createDatabase, type Database } from '../database.js';
import { runInTransaction } from '../transaction.js';
import { PrismaConversationRepository } from './conversation.repository.js';
import { PrismaMembershipRepository } from './membership.repository.js';
import { PrismaMessageRepository } from './message.repository.js';
import { PrismaNotificationRepository } from './notification.repository.js';

// Spec 030: repositório de notificações contra o Postgres (isolamento, CHECKs, FKs compostas e o
// índice único parcial "uma aberta por conversa").

const config = loadIntegrationConfig();
const HASH = 'scrypt$1$1$1$c2Fs$aGFzaA';
const NOW = new Date('2026-11-11T12:00:00.000Z');

let database: Database;
let tenants: TestTenants;
let repo: PrismaNotificationRepository;
let companyA: Company;
let companyB: Company;
let conversationA: Conversation;
let conversationA2: Conversation;
let conversationB: Conversation;
let replyA: Message;
let replyA2: Message;
let replyB: Message;
let memberA: Membership;
let memberB: Membership;

async function reply(company: Company, conversation: Conversation): Promise<Message> {
  const messages = new PrismaMessageRepository(database.prisma);
  const user = await messages.create(company.id, {
    conversationId: conversation.id,
    role: 'USER',
    content: 'pergunta',
  });
  return messages.create(company.id, {
    conversationId: conversation.id,
    role: 'ASSISTANT',
    content: 'resposta',
    replyToId: user.id,
    createdAt: new Date(user.createdAt.getTime() + 1),
  });
}

function rawInsert(data: {
  companyId?: string;
  conversationId?: string;
  messageId?: string;
  kind?: 'HUMAN_HANDOFF';
  reason?: 'CONTACT_REQUESTED' | null;
  status?: 'OPEN' | 'RESOLVED';
  resolvedAt?: Date | null;
  resolvedByMembershipId?: string | null;
}) {
  return database.prisma.notification.create({
    data: {
      companyId: data.companyId ?? companyA.id,
      kind: data.kind ?? 'HUMAN_HANDOFF',
      reason: data.reason === undefined ? 'CONTACT_REQUESTED' : data.reason,
      conversationId: data.conversationId ?? conversationA2.id,
      messageId: data.messageId ?? replyA2.id,
      status: data.status ?? 'OPEN',
      resolvedAt: data.resolvedAt ?? null,
      resolvedByMembershipId: data.resolvedByMembershipId ?? null,
    },
  });
}

async function clearNotifications(): Promise<void> {
  for (const company of [companyA, companyB]) {
    await database.prisma.notification.deleteMany({ where: { companyId: company.id } });
  }
}

before(async () => {
  database = createDatabase(config, createLogger(config));
  tenants = new TestTenants(database.prisma);
  repo = new PrismaNotificationRepository(database.prisma);
  const conversations = new PrismaConversationRepository(database.prisma);
  const memberships = new PrismaMembershipRepository(database.prisma);
  companyA = await tenants.createCompany('notif-a');
  companyB = await tenants.createCompany('notif-b');
  conversationA = await conversations.findOrCreateByContact(companyA.id, 'mesmo-contato');
  conversationA2 = await conversations.findOrCreateByContact(companyA.id, 'outro-contato');
  conversationB = await conversations.findOrCreateByContact(companyB.id, 'mesmo-contato');
  replyA = await reply(companyA, conversationA);
  replyA2 = await reply(companyA, conversationA2);
  replyB = await reply(companyB, conversationB);
  memberA = await memberships.create(companyA.id, {
    email: `a-${randomUUID()}@exemplo.com`,
    passwordHash: HASH,
    role: 'AGENT',
  });
  memberB = await memberships.create(companyB.id, {
    email: `b-${randomUUID()}@exemplo.com`,
    passwordHash: HASH,
    role: 'AGENT',
  });
});

after(async () => {
  await tenants.cleanup();
  await database.close();
});

describe('PrismaNotificationRepository', () => {
  it('cria, deduplica a aberta da mesma conversa e respeita o teto', async () => {
    await clearNotifications();
    const data = {
      reason: 'CONTACT_REQUESTED' as const,
      conversationId: conversationA.id,
      messageId: replyA.id,
      createdAt: NOW,
    };
    assert.equal(await repo.createHandoff(companyA.id, data, 500), 'created');
    assert.equal(await repo.createHandoff(companyA.id, data, 500), 'deduplicated');
    assert.equal(
      await repo.createHandoff(
        companyA.id,
        { ...data, conversationId: conversationA2.id, messageId: replyA2.id },
        1,
      ),
      'capped',
    );
    assert.equal(await repo.countOpen(companyA.id), 1);
    assert.equal(await repo.countOpen(companyB.id), 0);
  });

  it('dois pedidos simultâneos na mesma conversa: só um grava (índice parcial), sem abortar a transação', async () => {
    await clearNotifications();
    const data = {
      reason: 'COMPLAINT' as const,
      conversationId: conversationA.id,
      messageId: replyA.id,
      createdAt: NOW,
    };
    const results = await Promise.all(
      [1, 2].map(() =>
        runInTransaction(database.prisma, (tx) =>
          repo.forTransaction(tx).createHandoff(companyA.id, data, 500),
        ),
      ),
    );
    assert.deepEqual([...results].sort(), ['created', 'deduplicated']);
    assert.equal(await repo.countOpen(companyA.id), 1);
  });

  it('isolamento: a empresa B não lista, não conta, não resolve nem lê a aberta de A', async () => {
    await clearNotifications();
    await repo.createHandoff(
      companyA.id,
      {
        reason: 'OTHER',
        conversationId: conversationA.id,
        messageId: replyA.id,
        createdAt: NOW,
      },
      500,
    );
    const [rowA] = (await repo.list(companyA.id, 'open')).items;
    assert.ok(rowA);
    assert.equal((await repo.list(companyB.id, 'all')).items.length, 0);
    assert.equal(await repo.countOpen(companyB.id), 0);
    await assert.rejects(repo.resolve(companyB.id, rowA.id, memberB.id, NOW), NotFoundError);
    assert.equal((await repo.openHandoffsByConversation(companyB.id, [conversationA.id])).size, 0);
    const mine = await repo.openHandoffsByConversation(companyA.id, [
      conversationA.id,
      conversationA2.id,
      'nao-e-uuid',
    ]);
    assert.equal(mine.size, 1);
    assert.equal(mine.get(conversationA.id)?.notificationId, rowA.id);
  });

  it('resolver é idempotente e mantém quem resolveu primeiro; id malformado ou inexistente é 404', async () => {
    await clearNotifications();
    await repo.createHandoff(
      companyA.id,
      {
        reason: 'SENSITIVE',
        conversationId: conversationA.id,
        messageId: replyA.id,
        createdAt: NOW,
      },
      500,
    );
    const [row] = (await repo.list(companyA.id, 'open')).items;
    assert.ok(row);
    assert.equal(await repo.resolve(companyA.id, row.id, memberA.id, NOW), 'resolved');
    assert.equal(
      await repo.resolve(companyA.id, row.id, memberA.id, new Date(NOW.getTime() + 1)),
      'already',
    );
    const [resolved] = (await repo.list(companyA.id, 'resolved')).items;
    assert.equal(resolved?.resolvedByMembershipId, memberA.id);
    assert.equal(resolved.resolvedAt?.toISOString(), NOW.toISOString());
    assert.equal((await repo.list(companyA.id, 'open')).items.length, 0);
    await assert.rejects(repo.resolve(companyA.id, 'xyz', memberA.id, NOW), NotFoundError);
    await assert.rejects(repo.resolve(companyA.id, randomUUID(), memberA.id, NOW), NotFoundError);
    // Resolvida, a conversa pode abrir outra.
    assert.equal(
      await repo.createHandoff(
        companyA.id,
        {
          reason: 'OTHER',
          conversationId: conversationA.id,
          messageId: replyA.id,
          createdAt: NOW,
        },
        500,
      ),
      'created',
    );
  });

  it('lista em ordem decrescente com cursor; cursor inválido é 400', async () => {
    await clearNotifications();
    for (const [index, pair] of [
      [conversationA, replyA],
      [conversationA2, replyA2],
    ].entries()) {
      const [conversation, message] = pair as [Conversation, Message];
      await repo.createHandoff(
        companyA.id,
        {
          reason: 'OTHER',
          conversationId: conversation.id,
          messageId: message.id,
          createdAt: new Date(NOW.getTime() + index * 1000),
        },
        500,
      );
    }
    const first = await repo.list(companyA.id, 'open', { limit: 1 });
    assert.equal(first.items[0]?.conversationId, conversationA2.id);
    assert.ok(first.nextCursor);
    const second = await repo.list(companyA.id, 'open', { limit: 1, cursor: first.nextCursor });
    assert.equal(second.items[0]?.conversationId, conversationA.id);
    assert.equal(second.nextCursor, null);
    await assert.rejects(repo.list(companyA.id, 'open', { cursor: 'lixo' }), ValidationError);
  });
});

describe('integridade no banco', () => {
  it('CHECK de motivo: HUMAN_HANDOFF exige motivo', async () => {
    await clearNotifications();
    await assert.rejects(rawInsert({ reason: null }));
  });

  it('CHECK de resolução: OPEN sem resolução; RESOLVED com quando e quem', async () => {
    await clearNotifications();
    await assert.rejects(rawInsert({ status: 'OPEN', resolvedAt: NOW }));
    await assert.rejects(rawInsert({ status: 'RESOLVED' }));
    await assert.rejects(rawInsert({ status: 'RESOLVED', resolvedAt: NOW }));
    await rawInsert({ status: 'RESOLVED', resolvedAt: NOW, resolvedByMembershipId: memberA.id });
  });

  it('chaves estrangeiras compostas: conversa, mensagem e vínculo de outra empresa são recusados', async () => {
    await clearNotifications();
    await assert.rejects(rawInsert({ conversationId: conversationB.id }));
    await assert.rejects(rawInsert({ messageId: replyB.id }));
    await assert.rejects(
      rawInsert({ status: 'RESOLVED', resolvedAt: NOW, resolvedByMembershipId: memberB.id }),
    );
  });

  it('índice único parcial: duas abertas na mesma conversa não; aberta + resolvida sim', async () => {
    await clearNotifications();
    await rawInsert({});
    await assert.rejects(rawInsert({}));
    await rawInsert({ status: 'RESOLVED', resolvedAt: NOW, resolvedByMembershipId: memberA.id });
  });
});
