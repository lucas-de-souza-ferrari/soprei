import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  type Company,
  CompanyId,
  type Conversation,
  type NewConversation,
} from '../../../domain/index.js';
import {
  ConflictError,
  NotFoundError,
  TenantScopeError,
  ValidationError,
} from '../../../shared/errors/index.js';
import { loadIntegrationConfig } from '../../../test-support/integration-env.js';
import { TestTenants } from '../../../test-support/tenant-fixtures.js';
import { createLogger } from '../../logger/logger.js';
import { createDatabase, type Database } from '../database.js';
import { PrismaConversationRepository } from './conversation.repository.js';
import { runInTransaction } from '../transaction.js';

const config = loadIntegrationConfig();
let refCounter = 0;
/** `contactRef` distinto a cada chamada (a unicidade é por empresa e contato). */
const nextRef = (): string => `contato-${String((refCounter += 1))}`;

let database: Database;
let tenants: TestTenants;
let repo: PrismaConversationRepository;
let companyA: Company;
let companyB: Company;
let idsA: string[];
let idsB: string[];

before(async () => {
  database = createDatabase(config, createLogger(config));
  tenants = new TestTenants(database.prisma);
  repo = new PrismaConversationRepository(database.prisma);
  companyA = await tenants.createCompany('iso-a');
  companyB = await tenants.createCompany('iso-b');
  // Criações em paralelo para que várias linhas caiam no mesmo milissegundo (empate de createdAt).
  idsA = (
    await Promise.all(
      Array.from({ length: 7 }, () => repo.create(companyA.id, { contactRef: nextRef() })),
    )
  ).map((conversation) => conversation.id);
  idsB = (
    await Promise.all(
      Array.from({ length: 4 }, () => repo.create(companyB.id, { contactRef: nextRef() })),
    )
  ).map((conversation) => conversation.id);
});

after(async () => {
  try {
    await tenants.cleanup();
  } finally {
    await database.close();
  }
});

async function listAll(companyId: CompanyId, limit: number): Promise<Conversation[]> {
  const all: Conversation[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 50; pages++) {
    const page = await repo.list(companyId, { limit, ...(cursor === undefined ? {} : { cursor }) });
    assert.ok(page.items.length <= limit);
    all.push(...page.items);
    if (page.nextCursor === null) return all;
    cursor = page.nextCursor;
  }
  throw new Error('paginação não terminou');
}

describe('isolamento no repositório de Conversation (empresas A e B)', () => {
  it('findById: o id de B com o CompanyId de A é NotFoundError; com o de B, funciona', async () => {
    const id = idsB[0] ?? '';
    await assert.rejects(repo.findById(companyA.id, id), NotFoundError);
    const found = await repo.findById(companyB.id, id);
    assert.equal(found.id, id);
    assert.equal(found.companyId, companyB.id);
  });

  it('findById devolve a entidade de domínio com CompanyId', async () => {
    const found = await repo.findById(companyA.id, idsA[0] ?? '');
    assert.equal(found.companyId, companyA.id);
    assert.ok(found.createdAt instanceof Date);
  });

  it('update: com o CompanyId de A, o registro de B continua intacto e dá NotFoundError', async () => {
    const id = idsB[1] ?? '';
    const before = await repo.findById(companyB.id, id);
    await assert.rejects(repo.update(companyA.id, id, {}), NotFoundError);
    const after = await repo.findById(companyB.id, id);
    assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime());
  });

  it('update: o dono atualiza o próprio registro (updatedAt avança)', async () => {
    const id = idsA[0] ?? '';
    const before = await repo.findById(companyA.id, id);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const updated = await repo.update(companyA.id, id, {});
    assert.equal(updated.id, id);
    assert.ok(updated.updatedAt.getTime() > before.updatedAt.getTime());
  });

  it('delete: com o CompanyId de A, o registro de B não é apagado e dá NotFoundError', async () => {
    const id = idsB[2] ?? '';
    const countBefore = await repo.count(companyB.id);
    await assert.rejects(repo.delete(companyA.id, id), NotFoundError);
    assert.equal(await repo.count(companyB.id), countBefore);
    assert.equal((await repo.findById(companyB.id, id)).id, id);
  });

  it('delete: o dono apaga o próprio registro e depois ele é NotFoundError', async () => {
    const created = await repo.create(companyA.id, { contactRef: nextRef() });
    await repo.delete(companyA.id, created.id);
    await assert.rejects(repo.findById(companyA.id, created.id), NotFoundError);
    await assert.rejects(repo.delete(companyA.id, created.id), NotFoundError);
  });

  it('count: cada empresa conta só os seus', async () => {
    assert.equal(await repo.count(companyA.id), idsA.length);
    assert.equal(await repo.count(companyB.id), idsB.length);
  });

  it('count e list de uma empresa sem registros dão zero e página vazia', async () => {
    const empty = await tenants.createCompany('iso-vazio');
    assert.equal(await repo.count(empty.id), 0);
    assert.deepEqual(await repo.list(empty.id), { items: [], nextCursor: null });
  });
});

describe('listagem paginada por cursor', () => {
  it('list e count de A não incluem registros de B, atravessando várias páginas', async () => {
    const listed = await listAll(companyA.id, 2); // 7 itens, limit 2: 4 páginas
    const ids = listed.map((conversation) => conversation.id);
    assert.deepEqual([...ids].sort(), [...idsA].sort());
    assert.ok(listed.every((conversation) => conversation.companyId === companyA.id));
    assert.ok(ids.every((id) => !idsB.includes(id)));
    assert.equal(new Set(ids).size, ids.length, 'sem repetição entre páginas');
    assert.equal(ids.length, await repo.count(companyA.id));

    const listedB = await listAll(companyB.id, 3);
    assert.deepEqual(listedB.map((c) => c.id).sort(), [...idsB].sort());
  });

  it('a ordem é estável: createdAt e depois id, crescentes, igual em qualquer tamanho de página', async () => {
    const byOne = await listAll(companyA.id, 1);
    const bySeven = await listAll(companyA.id, 7);
    const byDefault = (await repo.list(companyA.id)).items;
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
    const total = await repo.count(companyB.id);
    const page = await repo.list(companyB.id, { limit: total });
    assert.equal(page.items.length, total);
    assert.equal(page.nextCursor, null);
  });

  it('um cursor de A usado com o CompanyId de B só devolve registros de B', async () => {
    const first = await repo.list(companyA.id, { limit: 1 });
    assert.ok(first.nextCursor !== null);
    const other = await repo.list(companyB.id, { cursor: first.nextCursor });
    // As conversas de B são mais novas que o cursor de A: a página tem itens (senão o teste seria vácuo).
    assert.ok(other.items.length > 0, 'a página de B tem itens');
    assert.ok(other.items.every((conversation) => conversation.companyId === companyB.id));
    assert.ok(other.items.every((conversation) => idsB.includes(conversation.id)));
  });

  it('limit fora do intervalo e cursor inválido dão ValidationError', async () => {
    for (const limit of [0, 201, -5, 1.5]) {
      await assert.rejects(repo.list(companyA.id, { limit }), ValidationError, String(limit));
    }
    await assert.rejects(repo.list(companyA.id, { cursor: 'lixo' }), ValidationError);
    assert.equal((await repo.list(companyA.id, { limit: 200 })).items.length, idsA.length);
  });
});

describe('create', () => {
  it('grava na empresa do parâmetro mesmo com outro companyId injetado em runtime', async () => {
    const hostile = { contactRef: nextRef(), companyId: companyB.id } as unknown as NewConversation;
    const created = await repo.create(companyA.id, hostile);
    assert.equal(created.companyId, companyA.id);
    assert.equal((await repo.findById(companyA.id, created.id)).id, created.id);
    await assert.rejects(repo.findById(companyB.id, created.id), NotFoundError);
    await repo.delete(companyA.id, created.id);
  });

  it('empresa inexistente: a FK impede (DatabaseError), nada é gravado', async () => {
    const ghost = CompanyId.parse('01890a5d-ac96-774b-bcce-b302099a8057');
    await assert.rejects(repo.create(ghost, { contactRef: nextRef() }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'DatabaseError');
      return true;
    });
    assert.equal(await repo.count(ghost), 0);
  });
});

describe('contactRef e findOrCreateByContact', () => {
  it('cria na primeira chamada e devolve a mesma conversa nas seguintes', async () => {
    const ref = nextRef();
    const first = await repo.findOrCreateByContact(companyA.id, ref);
    const second = await repo.findOrCreateByContact(companyA.id, ref);
    assert.equal(first.contactRef, ref);
    assert.equal(first.companyId, companyA.id);
    assert.equal(second.id, first.id);
    await repo.delete(companyA.id, first.id);
  });

  it('o mesmo contactRef em A e em B dá conversas distintas, cada uma na sua empresa', async () => {
    const ref = nextRef();
    const inA = await repo.findOrCreateByContact(companyA.id, ref);
    const inB = await repo.findOrCreateByContact(companyB.id, ref);
    assert.notEqual(inA.id, inB.id);
    assert.equal(inA.companyId, companyA.id);
    assert.equal(inB.companyId, companyB.id);
    await assert.rejects(repo.findById(companyA.id, inB.id), NotFoundError);
    await assert.rejects(repo.findById(companyB.id, inA.id), NotFoundError);
    await repo.delete(companyA.id, inA.id);
    await repo.delete(companyB.id, inB.id);
  });

  it('chamadas simultâneas para o mesmo contato resultam numa única conversa', async () => {
    const ref = nextRef();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => repo.findOrCreateByContact(companyA.id, ref)),
    );
    assert.equal(new Set(results.map((conversation) => conversation.id)).size, 1);
    await repo.delete(companyA.id, results[0]?.id ?? '');
  });

  it('dentro de transação concorrente também: nenhuma transação é abortada pela corrida', async () => {
    const ref = nextRef();
    const ids = await Promise.all(
      Array.from({ length: 6 }, () =>
        runInTransaction(database.prisma, async (tx) => {
          const conversation = await repo
            .forTransaction(tx)
            .findOrCreateByContact(companyA.id, ref);
          return conversation.id;
        }),
      ),
    );
    assert.equal(new Set(ids).size, 1);
    await repo.delete(companyA.id, ids[0] ?? '');
  });

  it('create com contactRef repetido no mesma empresa é ConflictError; em outra empresa é permitido', async () => {
    const ref = nextRef();
    const created = await repo.create(companyA.id, { contactRef: ref });
    await assert.rejects(repo.create(companyA.id, { contactRef: ref }), ConflictError);
    const inB = await repo.create(companyB.id, { contactRef: ref });
    await repo.delete(companyA.id, created.id);
    await repo.delete(companyB.id, inB.id);
  });
});

describe('forTransaction', () => {
  it('opera dentro de runInTransaction e o rollback desfaz a criação', async () => {
    const before = await repo.count(companyA.id);
    const boom = new ValidationError('abortar');
    await assert.rejects(
      runInTransaction(database.prisma, async (tx) => {
        const inTx = repo.forTransaction(tx);
        await inTx.create(companyA.id, { contactRef: nextRef() });
        assert.equal(await inTx.count(companyA.id), before + 1);
        throw boom;
      }),
      (error: unknown) => error === boom,
    );
    assert.equal(await repo.count(companyA.id), before);
  });

  it('confirma (commit) e mantém o isolamento dentro da transação', async () => {
    const id = await runInTransaction(database.prisma, async (tx) => {
      const inTx = repo.forTransaction(tx);
      const created = await inTx.create(companyA.id, { contactRef: nextRef() });
      await assert.rejects(inTx.findById(companyB.id, created.id), NotFoundError);
      await assert.rejects(inTx.delete(companyA.id, idsB[0] ?? ''), NotFoundError);
      return created.id;
    });
    assert.equal((await repo.findById(companyA.id, id)).id, id);
    await repo.delete(companyA.id, id);
  });
});

describe('segunda barreira atrás do repositório', () => {
  it('o client estendido recusa conversation.findMany({}) mesmo com dados de várias empresas', async () => {
    await assert.rejects(
      database.prisma.conversation.findMany({}),
      (error: unknown) => error instanceof TenantScopeError,
    );
  });
});
