import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { ClientId, type TenantRepository } from '../../../domain/index.js';
import { Prisma } from '../../../generated/prisma/client.js';
import {
  ConflictError,
  DatabaseError,
  NotFoundError,
  ValidationError,
} from '../../../shared/errors/index.js';
import {
  PrismaTenantRepository,
  type TenantModelOps,
  type TenantWhere,
} from './tenant.repository.base.js';

interface Row {
  readonly id: string;
  readonly createdAt: Date;
  readonly clientId: string;
}
type Entity = Row;
type NewEntity = Readonly<Record<string, never>>;

interface Calls {
  findFirst: TenantWhere[];
  findMany: { where: TenantWhere; take: number }[];
  create: unknown[];
  updateMany: TenantWhere[];
  deleteMany: TenantWhere[];
  count: TenantWhere[];
}

function newCalls(): Calls {
  return { findFirst: [], findMany: [], create: [], updateMany: [], deleteMany: [], count: [] };
}

class FakeRepository extends PrismaTenantRepository<Row, Entity, NewEntity, NewEntity> {
  constructor(ops: TenantModelOps<Row, NewEntity, NewEntity>) {
    super({ entity: 'Fake', ops, map: (row) => row });
  }

  forTransaction(): TenantRepository<Entity, NewEntity, NewEntity> {
    return this;
  }
}

function setup(overrides: Partial<TenantModelOps<Row, NewEntity, NewEntity>> = {}): {
  repo: FakeRepository;
  calls: Calls;
} {
  const calls = newCalls();
  const row = (clientId: string): Row => ({ id: randomUUID(), createdAt: new Date(), clientId });
  const repo = new FakeRepository({
    findFirst: (where) => {
      calls.findFirst.push(where);
      return Promise.resolve(row(where.clientId));
    },
    findMany: ({ where, take }) => {
      calls.findMany.push({ where, take });
      return Promise.resolve([]);
    },
    create: (data) => {
      calls.create.push(data);
      return Promise.resolve(row(data.clientId));
    },
    updateMany: (where) => {
      calls.updateMany.push(where);
      return Promise.resolve({ count: 1 });
    },
    deleteMany: (where) => {
      calls.deleteMany.push(where);
      return Promise.resolve({ count: 1 });
    },
    count: (where) => {
      calls.count.push(where);
      return Promise.resolve(0);
    },
    ...overrides,
  });
  return { repo, calls };
}

const clientA = ClientId.parse(randomUUID());
const clientB = ClientId.parse(randomUUID());

describe('base de repositório de tenant (com operações falsas)', () => {
  it('toda operação monta o filtro com o clientId do parâmetro', async () => {
    const { repo, calls } = setup();
    const id = randomUUID();
    await repo.findById(clientA, id);
    await repo.list(clientA);
    await repo.create(clientA, {});
    await repo.update(clientA, id, {});
    await repo.delete(clientA, id);
    await repo.count(clientA);

    assert.deepEqual(calls.findMany[0]?.where, { clientId: clientA });
    assert.deepEqual(calls.updateMany, [{ id, clientId: clientA }]);
    assert.deepEqual(calls.deleteMany, [{ id, clientId: clientA }]);
    assert.deepEqual(calls.count, [{ clientId: clientA }]);
    // findById e o findFirst que update faz depois de atualizar
    assert.deepEqual(calls.findFirst, [
      { id, clientId: clientA },
      { id, clientId: clientA },
    ]);
  });

  it('create aplica o clientId do parâmetro depois do spread, mesmo com clientId em data', async () => {
    const { repo, calls } = setup();
    // O tipo proíbe `clientId` em NewEntity; aqui forçamos para provar que o runtime não cede.
    const hostile = { clientId: clientB } as unknown as NewEntity;
    const created = await repo.create(clientA, hostile);

    assert.deepEqual(calls.create, [{ clientId: clientA }]);
    assert.equal(created.clientId, clientA);
  });

  it('id de outro cliente (findFirst sem resultado) vira NotFoundError', async () => {
    const { repo } = setup({ findFirst: () => Promise.resolve(null) });
    await assert.rejects(repo.findById(clientA, randomUUID()), NotFoundError);
  });

  it('update e delete que afetam 0 linhas viram NotFoundError', async () => {
    const { repo } = setup({
      updateMany: () => Promise.resolve({ count: 0 }),
      deleteMany: () => Promise.resolve({ count: 0 }),
    });
    await assert.rejects(repo.update(clientA, randomUUID(), {}), NotFoundError);
    await assert.rejects(repo.delete(clientA, randomUUID()), NotFoundError);
  });

  it('update cujo registro some entre o updateMany e a leitura vira NotFoundError', async () => {
    const { repo } = setup({ findFirst: () => Promise.resolve(null) });
    await assert.rejects(repo.update(clientA, randomUUID(), {}), NotFoundError);
  });

  it('id malformado é NotFoundError e nem chega ao banco', async () => {
    const { repo, calls } = setup();
    await assert.rejects(repo.findById(clientA, 'nao-e-uuid'), NotFoundError);
    await assert.rejects(repo.update(clientA, "1' OR '1'='1", {}), NotFoundError);
    await assert.rejects(repo.delete(clientA, ''), NotFoundError);
    assert.deepEqual(calls.findFirst, []);
    assert.deepEqual(calls.updateMany, []);
    assert.deepEqual(calls.deleteMany, []);
  });

  it('a mensagem de NotFoundError não revela se o id existe em outro cliente', async () => {
    const { repo } = setup({ findFirst: () => Promise.resolve(null) });
    await assert.rejects(repo.findById(clientA, randomUUID()), (error: unknown) => {
      assert.ok(error instanceof NotFoundError);
      assert.equal(error.message, 'Recurso não encontrado');
      return true;
    });
  });

  it('list valida limit e cursor antes de consultar', async () => {
    const { repo, calls } = setup();
    await assert.rejects(repo.list(clientA, { limit: 0 }), ValidationError);
    await assert.rejects(repo.list(clientA, { limit: 201 }), ValidationError);
    await assert.rejects(repo.list(clientA, { cursor: 'invalido' }), ValidationError);
    assert.equal(calls.findMany.length, 0);
  });

  it('list busca limit + 1 (50 por padrão) e o cursor entra junto do clientId', async () => {
    const { repo, calls } = setup();
    await repo.list(clientA);
    await repo.list(clientA, { limit: 200 });
    assert.equal(calls.findMany[0]?.take, 51);
    assert.equal(calls.findMany[1]?.take, 201);
  });

  it('violação de unicidade (P2002) vira ConflictError', async () => {
    const { repo } = setup({
      create: () =>
        Promise.reject(
          new Prisma.PrismaClientKnownRequestError('duplicado: segredo-sql', {
            code: 'P2002',
            clientVersion: 'test',
          }),
        ),
    });
    await assert.rejects(repo.create(clientA, {}), (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.equal(error.statusCode, 409);
      assert.ok(!error.message.includes('segredo-sql'));
      return true;
    });
  });

  it('outras falhas do Prisma viram DatabaseError sem vazar a mensagem original', async () => {
    const { repo } = setup({
      count: () =>
        Promise.reject(
          new Prisma.PrismaClientKnownRequestError('SELECT segredo FROM tabela', {
            code: 'P2010',
            clientVersion: 'test',
          }),
        ),
    });
    await assert.rejects(repo.count(clientA), (error: unknown) => {
      assert.ok(error instanceof DatabaseError);
      assert.ok(!error.message.includes('SELECT'));
      return true;
    });
  });

  it('erro de regra (não do banco) sobe intacto', async () => {
    const business = new ValidationError('regra');
    const { repo } = setup({ count: () => Promise.reject(business) });
    await assert.rejects(repo.count(clientA), (error: unknown) => error === business);
  });
});
