import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Company, Conversation, Message } from '../../../domain/index.js';
import { NotFoundError, ValidationError } from '../../../shared/errors/index.js';
import { loadIntegrationConfig } from '../../../test-support/integration-env.js';
import { TestTenants } from '../../../test-support/tenant-fixtures.js';
import { createLogger } from '../../logger/logger.js';
import { createDatabase, type Database } from '../database.js';
import { runInTransaction } from '../transaction.js';
import { PrismaConversationRepository } from './conversation.repository.js';
import { PrismaMessageRepository } from './message.repository.js';

// Spec 024: ordem da lista por última atividade (`updatedAt` tocado pela gravação de mensagem) e
// histórico `desc`. Postgres real (soprei_test).
const config = loadIntegrationConfig();
/** Instantes bem no futuro, para valerem acima do `updatedAt` inicial (a hora real da criação). */
const BASE = new Date('2035-01-01T00:00:00.000Z').getTime();
const at = (seconds: number): Date => new Date(BASE + seconds * 1000);

let database: Database;
let tenants: TestTenants;
let conversations: PrismaConversationRepository;
let messages: PrismaMessageRepository;
let companyA: Company;
let companyB: Company;

before(async () => {
  database = createDatabase(config, createLogger(config));
  tenants = new TestTenants(database.prisma);
  conversations = new PrismaConversationRepository(database.prisma);
  messages = new PrismaMessageRepository(database.prisma);
  companyA = await tenants.createCompany('activity-a');
  companyB = await tenants.createCompany('activity-b');
});

after(async () => {
  try {
    await tenants.cleanup();
  } finally {
    await database.close();
  }
});

async function say(
  company: Company,
  conversation: Conversation,
  seconds: number,
  role: 'USER' | 'ASSISTANT' = 'USER',
): Promise<Message> {
  return messages.create(company.id, {
    conversationId: conversation.id,
    role,
    content: `texto ${String(seconds)}`,
    createdAt: at(seconds),
  });
}

async function activityIds(company: Company, limit = 100): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 50; pages += 1) {
    const page = await conversations.listByActivity(company.id, {
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    ids.push(...page.items.map((item) => item.id));
    if (page.nextCursor === null) return ids;
    cursor = page.nextCursor;
  }
  throw new Error('paginação não terminou');
}

describe('última atividade da conversa (spec 024)', () => {
  it('gravar mensagem leva o updatedAt ao createdAt dela e reordena a lista', async () => {
    const one = await conversations.findOrCreateByContact(companyA.id, 'ord-1');
    const two = await conversations.findOrCreateByContact(companyA.id, 'ord-2');
    const three = await conversations.findOrCreateByContact(companyA.id, 'ord-3');
    await say(companyA, one, 10);
    await say(companyA, two, 20);
    await say(companyA, three, 30);
    assert.deepEqual(await activityIds(companyA), [three.id, two.id, one.id]);

    const reply = await say(companyA, one, 40, 'ASSISTANT');
    assert.equal(
      (await conversations.findById(companyA.id, one.id)).updatedAt.getTime(),
      at(40).getTime(),
    );
    assert.equal(reply.createdAt.getTime(), at(40).getTime());
    assert.deepEqual(await activityIds(companyA), [one.id, three.id, two.id]);
  });

  it('o updatedAt nunca volta: mensagem mais antiga que a atividade atual não o recua', async () => {
    const conversation = await conversations.findOrCreateByContact(companyA.id, 'ord-nunca-volta');
    await say(companyA, conversation, 500);
    await say(companyA, conversation, 100);
    assert.equal(
      (await conversations.findById(companyA.id, conversation.id)).updatedAt.getTime(),
      at(500).getTime(),
    );
  });

  it('paginação por atividade: cursor percorre tudo sem repetir nem pular; a última página tem nextCursor nulo', async () => {
    const created: Conversation[] = [];
    for (let index = 0; index < 7; index += 1) {
      created.push(await conversations.findOrCreateByContact(companyB.id, `pag-${String(index)}`));
    }
    // Duas conversas com a MESMA atividade: o desempate é o id decrescente, estável.
    for (const [index, conversation] of created.entries()) {
      await say(companyB, conversation, 1000 + Math.floor(index / 2));
    }
    const all = await activityIds(companyB, 100);
    for (const limit of [1, 2, 3, 7, 50]) {
      assert.deepEqual(await activityIds(companyB, limit), all, `limit ${String(limit)}`);
    }
    assert.equal(new Set(all).size, all.length);
    const last = await conversations.listByActivity(companyB.id, { limit: 100 });
    assert.equal(last.nextCursor, null);
  });

  it('isolamento: a lista de A nunca contém conversa de B, nem com cursor de B', async () => {
    const mine = await conversations.findOrCreateByContact(companyA.id, 'iso-minha');
    const theirs = await conversations.findOrCreateByContact(companyB.id, 'iso-deles');
    await say(companyA, mine, 2000);
    await say(companyB, theirs, 2001);
    const pageB = await conversations.listByActivity(companyB.id, { limit: 1 });
    assert.notEqual(pageB.nextCursor, null);
    const idsOfA = await activityIds(companyA);
    assert.ok(idsOfA.includes(mine.id));
    assert.ok(!idsOfA.includes(theirs.id));
    const withForeignCursor = await conversations.listByActivity(companyA.id, {
      limit: 100,
      cursor: pageB.nextCursor ?? '',
    });
    const foreign = new Set(await activityIds(companyB));
    for (const item of withForeignCursor.items) assert.ok(!foreign.has(item.id));
  });

  it('gravar mensagem de A não altera nenhuma conversa de B', async () => {
    const mine = await conversations.findOrCreateByContact(companyA.id, 'toque-a');
    const theirs = await conversations.findOrCreateByContact(companyB.id, 'toque-b');
    const before = (await conversations.findById(companyB.id, theirs.id)).updatedAt;
    await say(companyA, mine, 3000);
    assert.equal(
      (await conversations.findById(companyB.id, theirs.id)).updatedAt.getTime(),
      before.getTime(),
    );
    // O banco recusa mensagem de A em conversa de B (chave estrangeira composta), sem tocar nada.
    await assert.rejects(
      messages.create(companyA.id, {
        conversationId: theirs.id,
        role: 'USER',
        content: 'intrusa',
        createdAt: at(3100),
      }),
    );
    assert.equal(
      (await conversations.findById(companyB.id, theirs.id)).updatedAt.getTime(),
      before.getTime(),
    );
  });

  it('o toque é da mesma transação: rollback desfaz mensagem e updatedAt', async () => {
    const conversation = await conversations.findOrCreateByContact(companyA.id, 'toque-rollback');
    await say(companyA, conversation, 4000);
    await assert.rejects(
      runInTransaction(database.prisma, async (tx) => {
        await messages.forTransaction(tx).create(companyA.id, {
          conversationId: conversation.id,
          role: 'USER',
          content: 'vai desfazer',
          createdAt: at(4500),
        });
        throw new Error('rollback proposital');
      }),
      /rollback proposital/u,
    );
    assert.equal(
      (await conversations.findById(companyA.id, conversation.id)).updatedAt.getTime(),
      at(4000).getTime(),
    );
  });

  it('cursor malformado e limit fora do intervalo são ValidationError', async () => {
    await assert.rejects(
      conversations.listByActivity(companyA.id, { cursor: 'lixo' }),
      ValidationError,
    );
    await assert.rejects(conversations.listByActivity(companyA.id, { limit: 0 }), ValidationError);
    await assert.rejects(
      conversations.listByActivity(companyA.id, { limit: 201 }),
      ValidationError,
    );
  });
});

describe('histórico decrescente (spec 024)', () => {
  it('order=desc é o inverso exato de asc, em qualquer tamanho de página, e o cursor só olha para trás', async () => {
    const conversation = await conversations.findOrCreateByContact(companyA.id, 'desc-hist');
    for (let index = 0; index < 9; index += 1) {
      await say(companyA, conversation, 6000 + index, index % 2 === 0 ? 'USER' : 'ASSISTANT');
    }
    const collect = async (order: 'asc' | 'desc', limit: number): Promise<string[]> => {
      const ids: string[] = [];
      let cursor: string | undefined;
      for (let pages = 0; pages < 20; pages += 1) {
        const page = await messages.listByConversation(
          companyA.id,
          conversation.id,
          { limit, ...(cursor === undefined ? {} : { cursor }) },
          order,
        );
        ids.push(...page.items.map((item) => item.id));
        if (page.nextCursor === null) return ids;
        cursor = page.nextCursor;
      }
      throw new Error('paginação não terminou');
    };
    const asc = await collect('asc', 100);
    assert.equal(asc.length, 9);
    for (const limit of [1, 2, 4, 9, 50]) {
      assert.deepEqual(await collect('desc', limit), [...asc].reverse(), `limit ${String(limit)}`);
    }
    // Sem `order`, o comportamento é o antigo (crescente).
    const implicit = await messages.listByConversation(companyA.id, conversation.id, {
      limit: 100,
    });
    assert.deepEqual(
      implicit.items.map((item) => item.id),
      asc,
    );

    // Mensagem nova depois da primeira página decrescente não duplica nem apaga nada.
    const first = await messages.listByConversation(
      companyA.id,
      conversation.id,
      { limit: 4 },
      'desc',
    );
    await say(companyA, conversation, 7000);
    const rest = await messages.listByConversation(
      companyA.id,
      conversation.id,
      { limit: 100, cursor: first.nextCursor ?? '' },
      'desc',
    );
    assert.deepEqual(
      [...first.items, ...rest.items].map((item) => item.id),
      [...asc].reverse().slice(0, 9),
    );
  });

  it('conversa de outra empresa não devolve nada e id malformado é NotFoundError', async () => {
    const theirs = await conversations.findOrCreateByContact(companyB.id, 'desc-alheia');
    await say(companyB, theirs, 8000);
    const page = await messages.listByConversation(companyA.id, theirs.id, {}, 'desc');
    assert.deepEqual(page.items, []);
    await assert.rejects(
      messages.listByConversation(companyA.id, 'nao-uuid', {}, 'desc'),
      NotFoundError,
    );
  });
});

describe('concorrência e paginação sobre dados que mudam (spec 024)', () => {
  it('mensagens simultâneas na mesma conversa: o updatedAt termina no maior createdAt e nunca recua', async () => {
    for (let round = 0; round < 8; round += 1) {
      const conversation = await conversations.findOrCreateByContact(
        companyA.id,
        `simultaneas-${String(round)}`,
      );
      const base = 20_000 + round * 100;
      // Ordem de disparo alternada: o resultado não pode depender de quem chega primeiro.
      const seconds =
        round % 2 === 0 ? [base + 1, base + 2, base + 3] : [base + 3, base + 1, base + 2];
      await Promise.all(seconds.map((second) => say(companyA, conversation, second)));
      assert.equal(
        (await conversations.findById(companyA.id, conversation.id)).updatedAt.getTime(),
        at(base + 3).getTime(),
        `rodada ${String(round)}`,
      );
    }
  });

  it('conversa que sobe ao topo entre a página 1 e a 2: nada duplica; a que subiu só reaparece ao reler a primeira página', async () => {
    const company = await tenants.createCompany('activity-c');
    const created: Conversation[] = [];
    for (let index = 0; index < 5; index += 1) {
      const conversation = await conversations.findOrCreateByContact(
        company.id,
        `pg-${String(index)}`,
      );
      await say(company, conversation, 30_000 + index);
      created.push(conversation);
    }
    // Atividade crescente: a lista é pg-4, pg-3, pg-2, pg-1, pg-0.
    const first = await conversations.listByActivity(company.id, { limit: 2 });
    assert.deepEqual(
      first.items.map((item) => item.id),
      [created[4]?.id, created[3]?.id],
    );
    // Entre as páginas, a conversa mais antiga (ainda não carregada) recebe mensagem e sobe ao topo.
    const moved = created[0];
    assert.ok(moved);
    await say(company, moved, 31_000);
    const second = await conversations.listByActivity(company.id, {
      limit: 10,
      cursor: first.nextCursor ?? '',
    });
    const loaded = [...first.items, ...second.items].map((item) => item.id);
    // Comportamento esperado do cursor: ele só olha para a frente do ponto em que parou. Nada se
    // repete e a conversa que subiu (acima do cursor) fica de fora desta navegação...
    assert.equal(new Set(loaded).size, loaded.length);
    assert.ok(!loaded.includes(moved.id));
    assert.deepEqual(
      second.items.map((item) => item.id),
      [created[2]?.id, created[1]?.id],
    );
    // ...e aparece no topo ao reler a primeira página ("Atualizar" no site).
    const refreshed = await conversations.listByActivity(company.id, { limit: 2 });
    assert.equal(refreshed.items[0]?.id, moved.id);
  });
});
