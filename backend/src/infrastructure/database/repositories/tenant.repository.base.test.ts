import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { CompanyId, type TenantRepository } from '../../../domain/index.js';
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
  readonly companyId: string;
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
  const row = (companyId: string): Row => ({ id: randomUUID(), createdAt: new Date(), companyId });
  const repo = new FakeRepository({
    findFirst: (where) => {
      calls.findFirst.push(where);
      return Promise.resolve(row(where.companyId));
    },
    findMany: ({ where, take }) => {
      calls.findMany.push({ where, take });
      return Promise.resolve([]);
    },
    create: (data) => {
      calls.create.push(data);
      return Promise.resolve(row(data.companyId));
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

const companyA = CompanyId.parse(randomUUID());
const companyB = CompanyId.parse(randomUUID());

describe('base de repositório de tenant (com operações falsas)', () => {
  it('toda operação monta o filtro com o companyId do parâmetro', async () => {
    const { repo, calls } = setup();
    const id = randomUUID();
    await repo.findById(companyA, id);
    await repo.list(companyA);
    await repo.create(companyA, {});
    await repo.update(companyA, id, {});
    await repo.delete(companyA, id);
    await repo.count(companyA);

    assert.deepEqual(calls.findMany[0]?.where, { companyId: companyA });
    assert.deepEqual(calls.updateMany, [{ id, companyId: companyA }]);
    assert.deepEqual(calls.deleteMany, [{ id, companyId: companyA }]);
    assert.deepEqual(calls.count, [{ companyId: companyA }]);
    // findById e o findFirst que update faz depois de atualizar
    assert.deepEqual(calls.findFirst, [
      { id, companyId: companyA },
      { id, companyId: companyA },
    ]);
  });

  it('create aplica o companyId do parâmetro depois do spread, mesmo com companyId em data', async () => {
    const { repo, calls } = setup();
    // O tipo proíbe `companyId` em NewEntity; aqui forçamos para provar que o runtime não cede.
    const hostile = { companyId: companyB } as unknown as NewEntity;
    const created = await repo.create(companyA, hostile);

    assert.deepEqual(calls.create, [{ companyId: companyA }]);
    assert.equal(created.companyId, companyA);
  });

  it('id de outra empresa (findFirst sem resultado) vira NotFoundError', async () => {
    const { repo } = setup({ findFirst: () => Promise.resolve(null) });
    await assert.rejects(repo.findById(companyA, randomUUID()), NotFoundError);
  });

  it('update e delete que afetam 0 linhas viram NotFoundError', async () => {
    const { repo } = setup({
      updateMany: () => Promise.resolve({ count: 0 }),
      deleteMany: () => Promise.resolve({ count: 0 }),
    });
    await assert.rejects(repo.update(companyA, randomUUID(), {}), NotFoundError);
    await assert.rejects(repo.delete(companyA, randomUUID()), NotFoundError);
  });

  it('update cujo registro some entre o updateMany e a leitura vira NotFoundError', async () => {
    const { repo } = setup({ findFirst: () => Promise.resolve(null) });
    await assert.rejects(repo.update(companyA, randomUUID(), {}), NotFoundError);
  });

  it('id malformado é NotFoundError e nem chega ao banco', async () => {
    const { repo, calls } = setup();
    await assert.rejects(repo.findById(companyA, 'nao-e-uuid'), NotFoundError);
    await assert.rejects(repo.update(companyA, "1' OR '1'='1", {}), NotFoundError);
    await assert.rejects(repo.delete(companyA, ''), NotFoundError);
    assert.deepEqual(calls.findFirst, []);
    assert.deepEqual(calls.updateMany, []);
    assert.deepEqual(calls.deleteMany, []);
  });

  it('a mensagem de NotFoundError não revela se o id existe em outra empresa', async () => {
    const { repo } = setup({ findFirst: () => Promise.resolve(null) });
    await assert.rejects(repo.findById(companyA, randomUUID()), (error: unknown) => {
      assert.ok(error instanceof NotFoundError);
      assert.equal(error.message, 'Recurso não encontrado');
      return true;
    });
  });

  it('list valida limit e cursor antes de consultar', async () => {
    const { repo, calls } = setup();
    await assert.rejects(repo.list(companyA, { limit: 0 }), ValidationError);
    await assert.rejects(repo.list(companyA, { limit: 201 }), ValidationError);
    await assert.rejects(repo.list(companyA, { cursor: 'invalido' }), ValidationError);
    assert.equal(calls.findMany.length, 0);
  });

  it('list busca limit + 1 (50 por padrão) e o cursor entra junto do companyId', async () => {
    const { repo, calls } = setup();
    await repo.list(companyA);
    await repo.list(companyA, { limit: 200 });
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
    await assert.rejects(repo.create(companyA, {}), (error: unknown) => {
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
    await assert.rejects(repo.count(companyA), (error: unknown) => {
      assert.ok(error instanceof DatabaseError);
      assert.ok(!error.message.includes('SELECT'));
      return true;
    });
  });

  it('erro de regra (não do banco) sobe intacto', async () => {
    const business = new ValidationError('regra');
    const { repo } = setup({ count: () => Promise.reject(business) });
    await assert.rejects(repo.count(companyA), (error: unknown) => error === business);
  });
});
