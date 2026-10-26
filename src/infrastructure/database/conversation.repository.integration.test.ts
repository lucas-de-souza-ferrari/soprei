import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  type Client,
  ClientId,
  type Conversation,
  type NewConversation,
} from '../../domain/index.js';
import { NotFoundError, TenantScopeError, ValidationError } from '../../shared/errors/index.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import { createLogger } from '../logger/logger.js';
import { createDatabase, type Database } from './database.js';
import { PrismaConversationRepository } from './conversation.repository.js';
import { runInTransaction } from './transaction.js';

const config = loadIntegrationConfig();

let database: Database;
let tenants: TestTenants;
let repo: PrismaConversationRepository;
let clientA: Client;
let clientB: Client;
let idsA: string[];
let idsB: string[];

before(async () => {
  database = createDatabase(config, createLogger(config));
  tenants = new TestTenants(database.prisma);
  repo = new PrismaConversationRepository(database.prisma);
  clientA = await tenants.createClient('iso-a');
  clientB = await tenants.createClient('iso-b');
  // Criações em paralelo para que várias linhas caiam no mesmo milissegundo (empate de createdAt).
  idsA = (await Promise.all(Array.from({ length: 7 }, () => repo.create(clientA.id, {})))).map(
    (conversation) => conversation.id,
  );
  idsB = (await Promise.all(Array.from({ length: 4 }, () => repo.create(clientB.id, {})))).map(
    (conversation) => conversation.id,
  );
});

after(async () => {
  try {
    await tenants.cleanup();
  } finally {
    await database.close();
  }
});

async function listAll(clientId: ClientId, limit: number): Promise<Conversation[]> {
  const all: Conversation[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 50; pages++) {
    const page = await repo.list(clientId, { limit, ...(cursor === undefined ? {} : { cursor }) });
    assert.ok(page.items.length <= limit);
    all.push(...page.items);
    if (page.nextCursor === null) return all;
    cursor = page.nextCursor;
  }
  throw new Error('paginação não terminou');
}

describe('isolamento no repositório de Conversation (clientes A e B)', () => {
  it('findById: o id de B com o ClientId de A é NotFoundError; com o de B, funciona', async () => {
    const id = idsB[0] ?? '';
    await assert.rejects(repo.findById(clientA.id, id), NotFoundError);
    const found = await repo.findById(clientB.id, id);
    assert.equal(found.id, id);
    assert.equal(found.clientId, clientB.id);
  });

  it('findById devolve a entidade de domínio com ClientId', async () => {
    const found = await repo.findById(clientA.id, idsA[0] ?? '');
    assert.equal(found.clientId, clientA.id);
    assert.ok(found.createdAt instanceof Date);
  });

  it('update: com o ClientId de A, o registro de B continua intacto e dá NotFoundError', async () => {
    const id = idsB[1] ?? '';
    const before = await repo.findById(clientB.id, id);
    await assert.rejects(repo.update(clientA.id, id, {}), NotFoundError);
    const after = await repo.findById(clientB.id, id);
    assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime());
  });

  it('update: o dono atualiza o próprio registro (updatedAt avança)', async () => {
    const id = idsA[0] ?? '';
    const before = await repo.findById(clientA.id, id);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const updated = await repo.update(clientA.id, id, {});
    assert.equal(updated.id, id);
    assert.ok(updated.updatedAt.getTime() > before.updatedAt.getTime());
  });

  it('delete: com o ClientId de A, o registro de B não é apagado e dá NotFoundError', async () => {
    const id = idsB[2] ?? '';
    const countBefore = await repo.count(clientB.id);
    await assert.rejects(repo.delete(clientA.id, id), NotFoundError);
    assert.equal(await repo.count(clientB.id), countBefore);
    assert.equal((await repo.findById(clientB.id, id)).id, id);
  });

  it('delete: o dono apaga o próprio registro e depois ele é NotFoundError', async () => {
    const created = await repo.create(clientA.id, {});
    await repo.delete(clientA.id, created.id);
    await assert.rejects(repo.findById(clientA.id, created.id), NotFoundError);
    await assert.rejects(repo.delete(clientA.id, created.id), NotFoundError);
  });

  it('count: cada cliente conta só os seus', async () => {
    assert.equal(await repo.count(clientA.id), idsA.length);
    assert.equal(await repo.count(clientB.id), idsB.length);
  });

  it('count e list de um cliente sem registros dão zero e página vazia', async () => {
    const empty = await tenants.createClient('iso-vazio');
    assert.equal(await repo.count(empty.id), 0);
    assert.deepEqual(await repo.list(empty.id), { items: [], nextCursor: null });
  });
});

describe('listagem paginada por cursor', () => {
  it('list e count de A não incluem registros de B, atravessando várias páginas', async () => {
    const listed = await listAll(clientA.id, 2); // 7 itens, limit 2: 4 páginas
    const ids = listed.map((conversation) => conversation.id);
    assert.deepEqual([...ids].sort(), [...idsA].sort());
    assert.ok(listed.every((conversation) => conversation.clientId === clientA.id));
    assert.ok(ids.every((id) => !idsB.includes(id)));
    assert.equal(new Set(ids).size, ids.length, 'sem repetição entre páginas');
    assert.equal(ids.length, await repo.count(clientA.id));

    const listedB = await listAll(clientB.id, 3);
    assert.deepEqual(listedB.map((c) => c.id).sort(), [...idsB].sort());
  });

  it('a ordem é estável: createdAt e depois id, crescentes, igual em qualquer tamanho de página', async () => {
    const byOne = await listAll(clientA.id, 1);
    const bySeven = await listAll(clientA.id, 7);
    const byDefault = (await repo.list(clientA.id)).items;
    const expected = [...byOne].sort(
      (left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime() ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
    assert.deepEqual(
      byOne.map((c) => c.id),
      expected.map((c) => c.id),
    );
    assert.deepEqual(
      bySeven.map((c) => c.id),
      byOne.map((c) => c.id),
    );
    assert.deepEqual(
      byDefault.map((c) => c.id),
      byOne.map((c) => c.id),
    );
  });

  it('nextCursor é nulo na última página e a página cheia exata não inventa próxima', async () => {
    const total = await repo.count(clientB.id);
    const page = await repo.list(clientB.id, { limit: total });
    assert.equal(page.items.length, total);
    assert.equal(page.nextCursor, null);
  });

  it('um cursor de A usado com o ClientId de B só devolve registros de B', async () => {
    const first = await repo.list(clientA.id, { limit: 1 });
    assert.ok(first.nextCursor !== null);
    const other = await repo.list(clientB.id, { cursor: first.nextCursor });
    assert.ok(other.items.every((conversation) => conversation.clientId === clientB.id));
  });

  it('limit fora do intervalo e cursor inválido dão ValidationError', async () => {
    for (const limit of [0, 201, -5, 1.5]) {
      await assert.rejects(repo.list(clientA.id, { limit }), ValidationError, String(limit));
    }
    await assert.rejects(repo.list(clientA.id, { cursor: 'lixo' }), ValidationError);
    assert.equal((await repo.list(clientA.id, { limit: 200 })).items.length, idsA.length);
  });
});

describe('create', () => {
  it('grava no cliente do parâmetro mesmo com outro clientId injetado em runtime', async () => {
    const hostile = { clientId: clientB.id } as unknown as NewConversation;
    const created = await repo.create(clientA.id, hostile);
    assert.equal(created.clientId, clientA.id);
    assert.equal((await repo.findById(clientA.id, created.id)).id, created.id);
    await assert.rejects(repo.findById(clientB.id, created.id), NotFoundError);
    await repo.delete(clientA.id, created.id);
  });

  it('cliente inexistente: a FK impede (DatabaseError), nada é gravado', async () => {
    const ghost = ClientId.parse('01890a5d-ac96-774b-bcce-b302099a8057');
    await assert.rejects(repo.create(ghost, {}), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'DatabaseError');
      return true;
    });
    assert.equal(await repo.count(ghost), 0);
  });
});

describe('forTransaction', () => {
  it('opera dentro de runInTransaction e o rollback desfaz a criação', async () => {
    const before = await repo.count(clientA.id);
    const boom = new ValidationError('abortar');
    await assert.rejects(
      runInTransaction(database.prisma, async (tx) => {
        const inTx = repo.forTransaction(tx);
        await inTx.create(clientA.id, {});
        assert.equal(await inTx.count(clientA.id), before + 1);
        throw boom;
      }),
      (error: unknown) => error === boom,
    );
    assert.equal(await repo.count(clientA.id), before);
  });

  it('confirma (commit) e mantém o isolamento dentro da transação', async () => {
    const id = await runInTransaction(database.prisma, async (tx) => {
      const inTx = repo.forTransaction(tx);
      const created = await inTx.create(clientA.id, {});
      await assert.rejects(inTx.findById(clientB.id, created.id), NotFoundError);
      await assert.rejects(inTx.delete(clientA.id, idsB[0] ?? ''), NotFoundError);
      return created.id;
    });
    assert.equal((await repo.findById(clientA.id, id)).id, id);
    await repo.delete(clientA.id, id);
  });
});

describe('segunda barreira atrás do repositório', () => {
  it('o client estendido recusa conversation.findMany({}) mesmo com dados de vários clientes', async () => {
    await assert.rejects(
      database.prisma.conversation.findMany({}),
      (error: unknown) => error instanceof TenantScopeError,
    );
  });
});
