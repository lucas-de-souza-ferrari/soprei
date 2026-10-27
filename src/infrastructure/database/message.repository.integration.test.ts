import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { ClientId } from '../../domain/index.js';
import {
  type Client,
  type Conversation,
  type Message,
  type NewMessage,
} from '../../domain/index.js';
import {
  ConflictError,
  DatabaseError,
  NotFoundError,
  TenantScopeError,
  ValidationError,
} from '../../shared/errors/index.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import { createLogger } from '../logger/logger.js';
import { PrismaConversationRepository } from './conversation.repository.js';
import { createDatabase, type Database } from './database.js';
import { PrismaMessageRepository } from './message.repository.js';
import { runInTransaction } from './transaction.js';

const config = loadIntegrationConfig();

let database: Database;
let tenants: TestTenants;
let conversations: PrismaConversationRepository;
let repo: PrismaMessageRepository;
let clientA: Client;
let clientB: Client;
let conversationA: Conversation;
let conversationB: Conversation;
let idsA: string[];
let idsB: string[];
/** Mesmo `externalId` nos dois clientes: a unicidade é por cliente. */
const SHARED_EXTERNAL_ID = `ext-${randomUUID()}`;
let userA: Message;
let replyA: Message;
let userB: Message;
let replyB: Message;

before(async () => {
  database = createDatabase(config, createLogger(config));
  tenants = new TestTenants(database.prisma);
  conversations = new PrismaConversationRepository(database.prisma);
  repo = new PrismaMessageRepository(database.prisma);
  clientA = await tenants.createClient('msg-a');
  clientB = await tenants.createClient('msg-b');
  // Mesmo contactRef nos dois clientes: conversas distintas.
  conversationA = await conversations.findOrCreateByContact(clientA.id, 'mesmo-contato');
  conversationB = await conversations.findOrCreateByContact(clientB.id, 'mesmo-contato');

  userA = await repo.create(clientA.id, {
    conversationId: conversationA.id,
    role: 'USER',
    content: 'pergunta A',
    externalId: SHARED_EXTERNAL_ID,
  });
  replyA = await repo.create(clientA.id, {
    conversationId: conversationA.id,
    role: 'ASSISTANT',
    content: 'resposta A',
    replyToId: userA.id,
    createdAt: new Date(userA.createdAt.getTime() + 1),
  });
  userB = await repo.create(clientB.id, {
    conversationId: conversationB.id,
    role: 'USER',
    content: 'pergunta B',
    externalId: SHARED_EXTERNAL_ID,
  });
  replyB = await repo.create(clientB.id, {
    conversationId: conversationB.id,
    role: 'ASSISTANT',
    content: 'resposta B',
    replyToId: userB.id,
    isFallback: true,
    createdAt: new Date(userB.createdAt.getTime() + 1),
  });
  // Mais mensagens para paginar (criações em paralelo: empates de createdAt).
  const extraA = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      repo.create(clientA.id, {
        conversationId: conversationA.id,
        role: 'USER',
        content: `extra A ${String(i)}`,
      }),
    ),
  );
  const extraB = await Promise.all(
    Array.from({ length: 3 }, (_, i) =>
      repo.create(clientB.id, {
        conversationId: conversationB.id,
        role: 'USER',
        content: `extra B ${String(i)}`,
      }),
    ),
  );
  idsA = [userA, replyA, ...extraA].map((message) => message.id);
  idsB = [userB, replyB, ...extraB].map((message) => message.id);
});

after(async () => {
  try {
    await tenants.cleanup();
  } finally {
    await database.close();
  }
});

async function listAll(clientId: ClientId, conversationId: string, limit: number) {
  const all: Message[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 50; pages++) {
    const page = await repo.listByConversation(clientId, conversationId, {
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    all.push(...page.items);
    if (page.nextCursor === null) return all;
    cursor = page.nextCursor;
  }
  throw new Error('paginação não terminou');
}

describe('isolamento no repositório de Message (clientes A e B)', () => {
  it('findById: o id de B com o ClientId de A é NotFoundError; com o de B, funciona', async () => {
    await assert.rejects(repo.findById(clientA.id, userB.id), NotFoundError);
    const found = await repo.findById(clientB.id, userB.id);
    assert.equal(found.id, userB.id);
    assert.equal(found.clientId, clientB.id);
    assert.equal(found.content, 'pergunta B');
  });

  it('findById com id malformado é NotFoundError (não vai ao banco)', async () => {
    await assert.rejects(repo.findById(clientA.id, 'nao-e-uuid'), NotFoundError);
  });

  it('list e count: cada cliente enxerga só as suas mensagens', async () => {
    assert.equal(await repo.count(clientA.id), idsA.length);
    assert.equal(await repo.count(clientB.id), idsB.length);
    const listedA = (await repo.list(clientA.id, { limit: 200 })).items;
    assert.deepEqual(listedA.map((m) => m.id).sort(), [...idsA].sort());
    assert.ok(listedA.every((m) => m.clientId === clientA.id));
    assert.ok(listedA.every((m) => !idsB.includes(m.id)));
  });

  it('findByExternalId: o mesmo externalId em A e B devolve a mensagem de cada um', async () => {
    const foundA = await repo.findByExternalId(clientA.id, SHARED_EXTERNAL_ID);
    const foundB = await repo.findByExternalId(clientB.id, SHARED_EXTERNAL_ID);
    assert.equal(foundA?.id, userA.id);
    assert.equal(foundA.clientId, clientA.id);
    assert.equal(foundB?.id, userB.id);
    assert.equal(foundB.clientId, clientB.id);
    assert.equal(await repo.findByExternalId(clientA.id, 'inexistente'), null);
  });

  it('findByExternalId: externalId que só existe em B é null para A', async () => {
    const onlyB = `so-b-${randomUUID()}`;
    await repo.create(clientB.id, {
      conversationId: conversationB.id,
      role: 'USER',
      content: 'só do B',
      externalId: onlyB,
    });
    assert.equal(await repo.findByExternalId(clientA.id, onlyB), null);
    assert.notEqual(await repo.findByExternalId(clientB.id, onlyB), null);
  });

  it('findReplyTo: devolve a resposta do próprio cliente; o id de B com o ClientId de A é null', async () => {
    assert.equal((await repo.findReplyTo(clientA.id, userA.id))?.id, replyA.id);
    assert.equal((await repo.findReplyTo(clientB.id, userB.id))?.id, replyB.id);
    assert.equal((await repo.findReplyTo(clientB.id, userB.id))?.isFallback, true);
    assert.equal(await repo.findReplyTo(clientA.id, userB.id), null);
    assert.equal(await repo.findReplyTo(clientB.id, userA.id), null);
    assert.equal(await repo.findReplyTo(clientA.id, 'nao-e-uuid'), null);
    // Mensagem sem resposta.
    assert.equal(await repo.findReplyTo(clientA.id, replyA.id), null);
  });

  it('listRecent: só da conversa do próprio cliente, em ordem cronológica', async () => {
    const recentA = await repo.listRecent(clientA.id, conversationA.id, 100);
    assert.deepEqual(recentA.map((m) => m.id).sort(), [...idsA].sort());
    assert.ok(recentA.every((m) => m.clientId === clientA.id));
    for (let i = 1; i < recentA.length; i++) {
      assert.ok(
        (recentA[i - 1]?.createdAt.getTime() ?? 0) <= (recentA[i]?.createdAt.getTime() ?? 0),
      );
    }
    // A conversa de B com o ClientId de A: nada.
    assert.deepEqual(await repo.listRecent(clientA.id, conversationB.id, 100), []);
    assert.deepEqual(await repo.listRecent(clientB.id, conversationA.id, 100), []);
    assert.deepEqual(await repo.listRecent(clientA.id, 'nao-e-uuid', 10), []);
  });

  it('listRecent: devolve as N mais recentes (e a pergunta precede a resposta)', async () => {
    const lastTwo = await repo.listRecent(clientA.id, conversationA.id, 2);
    assert.equal(lastTwo.length, 2);
    const all = await repo.listRecent(clientA.id, conversationA.id, 100);
    assert.deepEqual(
      lastTwo.map((m) => m.id),
      all.slice(-2).map((m) => m.id),
    );
    const userIndex = all.findIndex((m) => m.id === userA.id);
    const replyIndex = all.findIndex((m) => m.id === replyA.id);
    assert.ok(userIndex < replyIndex, 'a pergunta vem antes da resposta');
    assert.deepEqual(await repo.listRecent(clientA.id, conversationA.id, 0), []);
  });

  it('listByConversation: a conversa de B com o ClientId de A não devolve mensagens de B', async () => {
    const page = await repo.listByConversation(clientA.id, conversationB.id);
    assert.deepEqual(page, { items: [], nextCursor: null });
    await assert.rejects(repo.listByConversation(clientA.id, 'nao-e-uuid'), NotFoundError);
  });

  it('listByConversation: pagina em ordem estável e igual em qualquer tamanho de página', async () => {
    const byOne = await listAll(clientA.id, conversationA.id, 1);
    const byThree = await listAll(clientA.id, conversationA.id, 3);
    const all = (await repo.listByConversation(clientA.id, conversationA.id, { limit: 200 })).items;
    assert.deepEqual(
      byOne.map((m) => m.id),
      all.map((m) => m.id),
    );
    assert.deepEqual(
      byThree.map((m) => m.id),
      all.map((m) => m.id),
    );
    assert.equal(new Set(byOne.map((m) => m.id)).size, idsA.length);
    assert.ok(
      byOne.every((m) => m.clientId === clientA.id && m.conversationId === conversationA.id),
    );
    await assert.rejects(
      repo.listByConversation(clientA.id, conversationA.id, { cursor: 'lixo' }),
      ValidationError,
    );
  });

  it('um cursor de A usado com o ClientId de B só devolve mensagens de B', async () => {
    const first = await repo.listByConversation(clientA.id, conversationA.id, { limit: 1 });
    assert.ok(first.nextCursor !== null);
    const other = await repo.listByConversation(clientB.id, conversationB.id, {
      cursor: first.nextCursor,
    });
    assert.ok(other.items.every((m) => m.clientId === clientB.id));
  });

  it('update e delete com o ClientId de A não tocam a mensagem de B (NotFoundError)', async () => {
    await assert.rejects(repo.update(clientA.id, userB.id, {}), NotFoundError);
    await assert.rejects(repo.delete(clientA.id, userB.id), NotFoundError);
    assert.equal((await repo.findById(clientB.id, userB.id)).content, 'pergunta B');
    // O dono "atualiza" (no-op: mensagens são imutáveis) e recebe a mesma mensagem.
    assert.equal((await repo.update(clientB.id, userB.id, {})).content, 'pergunta B');
  });
});

describe('create e integridade no banco (chave estrangeira composta)', () => {
  it('grava no cliente do parâmetro mesmo com outro clientId injetado em runtime', async () => {
    const hostile = {
      conversationId: conversationA.id,
      role: 'USER',
      content: 'hostil',
      clientId: clientB.id,
    } as unknown as NewMessage;
    const created = await repo.create(clientA.id, hostile);
    assert.equal(created.clientId, clientA.id);
    await assert.rejects(repo.findById(clientB.id, created.id), NotFoundError);
    await repo.delete(clientA.id, created.id);
  });

  it('mensagem do cliente A em conversa do cliente B é rejeitada pelo banco', async () => {
    const before = await repo.count(clientA.id);
    const beforeB = await repo.count(clientB.id);
    await assert.rejects(
      repo.create(clientA.id, {
        conversationId: conversationB.id,
        role: 'USER',
        content: 'não pode',
      }),
      (error: unknown) => error instanceof DatabaseError,
    );
    assert.equal(await repo.count(clientA.id), before);
    assert.equal(await repo.count(clientB.id), beforeB);
  });

  it('SQL cru: INSERT com client_id de A e conversation_id de B viola a chave estrangeira composta (23503)', async () => {
    await assert.rejects(
      database.prisma.$executeRaw`
        INSERT INTO messages (id, client_id, conversation_id, role, content)
        VALUES (${randomUUID()}::uuid, ${clientA.id}::uuid, ${conversationB.id}::uuid, 'USER'::message_role, 'cruzada')`,
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /23503|foreign key|messages_conversation_id_client_id_fkey/i);
        return true;
      },
    );
    const crossed = await database.prisma.$queryRaw<{ total: bigint }[]>`
      SELECT count(*) AS total FROM messages WHERE content = 'cruzada'`;
    assert.equal(crossed[0]?.total, 0n);
  });

  it('SQL cru: resposta (reply_to_id) de A apontando para mensagem de B viola a chave estrangeira composta', async () => {
    await assert.rejects(
      database.prisma.$executeRaw`
        INSERT INTO messages (id, client_id, conversation_id, role, content, reply_to_id)
        VALUES (${randomUUID()}::uuid, ${clientA.id}::uuid, ${conversationA.id}::uuid,
                'ASSISTANT'::message_role, 'resposta cruzada', ${userB.id}::uuid)`,
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /23503|foreign key|messages_reply_to_id_client_id_fkey/i);
        return true;
      },
    );
  });

  it('via repositório: replyToId de outro cliente também é rejeitado (DatabaseError)', async () => {
    await assert.rejects(
      repo.create(clientA.id, {
        conversationId: conversationA.id,
        role: 'ASSISTANT',
        content: 'resposta cruzada',
        replyToId: userB.id,
      }),
      (error: unknown) => error instanceof DatabaseError,
    );
  });

  it('SQL cru: as restrições de tamanho e de fallback também valem no banco', async () => {
    const insert = (role: string, content: string, isFallback: boolean) =>
      database.prisma.$executeRaw`
        INSERT INTO messages (id, client_id, conversation_id, role, content, is_fallback)
        VALUES (${randomUUID()}::uuid, ${clientA.id}::uuid, ${conversationA.id}::uuid,
                ${role}::message_role, ${content}, ${isFallback})`;
    await assert.rejects(insert('USER', '', false), /content_length_check|check/i);
    await assert.rejects(insert('USER', 'a'.repeat(4001), false), /content_length_check|check/i);
    await assert.rejects(insert('USER', 'fallback de usuário', true), /fallback_role_check|check/i);
  });

  it('externalId repetido no mesmo cliente é ConflictError; em outro cliente é permitido', async () => {
    const externalId = `dup-${randomUUID()}`;
    await repo.create(clientA.id, {
      conversationId: conversationA.id,
      role: 'USER',
      content: 'um',
      externalId,
    });
    await assert.rejects(
      repo.create(clientA.id, {
        conversationId: conversationA.id,
        role: 'USER',
        content: 'dois',
        externalId,
      }),
      ConflictError,
    );
    const inB = await repo.create(clientB.id, {
      conversationId: conversationB.id,
      role: 'USER',
      content: 'em outro cliente',
      externalId,
    });
    assert.equal(inB.clientId, clientB.id);
  });

  it('várias mensagens sem externalId convivem; uma mensagem do contato só aceita uma resposta', async () => {
    for (let i = 0; i < 3; i++) {
      await repo.create(clientA.id, {
        conversationId: conversationA.id,
        role: 'USER',
        content: `sem externalId ${String(i)}`,
      });
    }
    await assert.rejects(
      repo.create(clientA.id, {
        conversationId: conversationA.id,
        role: 'ASSISTANT',
        content: 'segunda resposta',
        replyToId: userA.id,
      }),
      ConflictError,
    );
  });

  it('dois envios simultâneos do mesmo externalId: um grava e o outro recebe ConflictError', async () => {
    const externalId = `race-${randomUUID()}`;
    const outcomes = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        repo.create(clientA.id, {
          conversationId: conversationA.id,
          role: 'USER',
          content: 'concorrente',
          externalId,
        }),
      ),
    );
    assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
    for (const o of outcomes.filter((candidate) => candidate.status === 'rejected')) {
      assert.ok(o.reason instanceof ConflictError);
    }
  });
});

describe('forTransaction e segunda barreira', () => {
  it('rollback desfaz a criação; commit confirma e mantém o isolamento dentro da transação', async () => {
    const before = await repo.count(clientA.id);
    const boom = new ValidationError('abortar');
    await assert.rejects(
      runInTransaction(database.prisma, async (tx) => {
        const inTx = repo.forTransaction(tx);
        await inTx.create(clientA.id, {
          conversationId: conversationA.id,
          role: 'USER',
          content: 'dentro da transação',
        });
        assert.equal(await inTx.count(clientA.id), before + 1);
        throw boom;
      }),
      (error: unknown) => error === boom,
    );
    assert.equal(await repo.count(clientA.id), before);

    const id = await runInTransaction(database.prisma, async (tx) => {
      const inTx = repo.forTransaction(tx);
      const created = await inTx.create(clientA.id, {
        conversationId: conversationA.id,
        role: 'USER',
        content: 'confirmada',
      });
      await assert.rejects(inTx.findById(clientB.id, created.id), NotFoundError);
      assert.equal(await inTx.findByExternalId(clientB.id, 'confirmada'), null);
      return created.id;
    });
    assert.equal((await repo.findById(clientA.id, id)).content, 'confirmada');
  });

  it('o client estendido recusa operações de message sem clientId (TenantScopeError)', async () => {
    const isScopeError = (error: unknown): boolean => error instanceof TenantScopeError;
    await assert.rejects(database.prisma.message.findMany({}), isScopeError);
    await assert.rejects(
      database.prisma.message.findFirst({ where: { externalId: 'x' } }),
      isScopeError,
    );
    await assert.rejects(database.prisma.message.count({}), isScopeError);
    await assert.rejects(database.prisma.message.deleteMany({}), isScopeError);
    await assert.rejects(
      database.prisma.message.findUnique({ where: { id: userA.id } }),
      isScopeError,
    );
    await assert.rejects(
      database.prisma.message.update({ where: { id: userA.id }, data: { content: 'x' } }),
      isScopeError,
    );
    await assert.rejects(
      database.prisma.message.create({
        data: { conversationId: conversationA.id, role: 'USER', content: 'x' } as never,
      }),
      isScopeError,
    );
  });
});
