import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../../../generated/prisma/client.js';
import { TenantScopeError } from '../../../shared/errors/index.js';
import { type ModelInfo, readModels } from './schema-info.js';
import {
  createTenantScopeGuard,
  extendWithTenantScope,
  findScopeProblems,
  MODEL_SCOPES,
  type ModelScope,
  type TenantScopeGuard,
} from './tenant-scope.js';

// O pool do `pg` só abre conexão na primeira query: estes testes não precisam de banco.
const base = new PrismaClient({
  adapter: new PrismaPg({ connectionString: 'postgresql://u:p@localhost:5432/db' }),
});
const models = readModels(base);

after(async () => {
  await base.$disconnect();
});

const companyA = randomUUID();
const companyB = randomUUID();

describe('cobertura do registro de models (lê o schema gerado)', () => {
  it('todo model do schema está classificado como a presença de companyId manda', () => {
    assert.deepEqual(findScopeProblems(models, MODEL_SCOPES), []);
  });

  it('o registro lista exatamente os models que o Prisma gerou', () => {
    assert.deepEqual(Object.keys(MODEL_SCOPES).sort(), Object.keys(Prisma.ModelName).sort());
    assert.deepEqual(models.map((model) => model.name).sort(), Object.keys(MODEL_SCOPES).sort());
  });

  it('Conversation e Message são de tenant (têm companyId) e Company é global (raiz do tenant)', () => {
    assert.equal(MODEL_SCOPES.Conversation, 'tenant');
    assert.equal(MODEL_SCOPES.Message, 'tenant');
    const message = models.find((model) => model.name === 'Message');
    assert.ok(message?.fields.some((field) => field.name === 'companyId'));
    assert.equal(MODEL_SCOPES.Company, 'global');
    const conversation = models.find((model) => model.name === 'Conversation');
    assert.ok(conversation?.fields.some((field) => field.name === 'companyId'));
  });

  const ticket: ModelInfo = {
    name: 'Ticket',
    fields: [
      { name: 'id', kind: 'scalar', type: 'String' },
      { name: 'companyId', kind: 'scalar', type: 'String' },
    ],
  };
  const label: ModelInfo = {
    name: 'Label',
    fields: [{ name: 'id', kind: 'scalar', type: 'String' }],
  };

  it('falha se um model com companyId não está no registro de tenant', () => {
    const problems = findScopeProblems([...models, ticket], MODEL_SCOPES);
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /Ticket/);
    assert.throws(() => createTenantScopeGuard([...models, ticket]), /Ticket/);
  });

  it('falha se um model com companyId foi registrado como global', () => {
    const scopes: Record<string, ModelScope> = { ...MODEL_SCOPES, Ticket: 'global' };
    assert.match(findScopeProblems([...models, ticket], scopes).join(), /Ticket.*tenant/);
  });

  it('falha se um model sem companyId não está na lista de globais', () => {
    assert.match(findScopeProblems([...models, label], MODEL_SCOPES).join(), /Label/);
    const asTenant: Record<string, ModelScope> = { ...MODEL_SCOPES, Label: 'tenant' };
    assert.match(findScopeProblems([...models, label], asTenant).join(), /Label.*global/);
  });

  it('falha se o registro lista um model que não existe mais', () => {
    const scopes: Record<string, ModelScope> = { ...MODEL_SCOPES, Fantasma: 'tenant' };
    assert.match(findScopeProblems(models, scopes).join(), /Fantasma/);
  });
});

describe('segunda barreira: regras da verificação', () => {
  const guard: TenantScopeGuard = createTenantScopeGuard(models);

  function run(model: string, operation: string, args: unknown): void {
    guard({ model, operation, args });
  }
  function rejects(model: string, operation: string, args: unknown): void {
    assert.throws(
      () => {
        run(model, operation, args);
      },
      (error: unknown) =>
        error instanceof TenantScopeError &&
        error.statusCode === 500 &&
        !error.isOperational &&
        error.code === 'TENANT_SCOPE_ERROR',
      `${model}.${operation} deveria ser rejeitado`,
    );
  }

  describe('model de tenant (Conversation)', () => {
    it('rejeita consulta sem companyId no where', () => {
      for (const operation of [
        'findMany',
        'findFirst',
        'findFirstOrThrow',
        'count',
        'aggregate',
        'groupBy',
        'updateMany',
        'updateManyAndReturn',
        'deleteMany',
      ]) {
        rejects('Conversation', operation, {});
        rejects('Conversation', operation, undefined);
        rejects('Conversation', operation, { where: {} });
        rejects('Conversation', operation, { where: { id: randomUUID() } });
      }
    });

    it('o nome antigo do escopo (clientId, spec 022) não vale mais: where ou data com ele é recusado', () => {
      rejects('Conversation', 'findMany', { where: { clientId: companyA } });
      rejects('Conversation', 'updateMany', { where: { clientId: companyA }, data: {} });
      rejects('Conversation', 'deleteMany', { where: { clientId: companyA } });
      rejects('Conversation', 'create', { data: { clientId: companyA, contactRef: 'x' } });
      rejects('Membership', 'findMany', { where: { clientId: companyA } });
    });

    it('rejeita companyId que não é um valor definido (undefined, null, vazio, in, not, OR)', () => {
      rejects('Conversation', 'findMany', { where: { companyId: undefined } });
      rejects('Conversation', 'findMany', { where: { companyId: null } });
      rejects('Conversation', 'findMany', { where: { companyId: '' } });
      rejects('Conversation', 'findMany', { where: { companyId: { in: [companyA, companyB] } } });
      rejects('Conversation', 'findMany', { where: { companyId: { not: companyA } } });
      rejects('Conversation', 'findMany', { where: { companyId: { equals: undefined } } });
      rejects('Conversation', 'findMany', { where: { OR: [{ companyId: companyA }] } });
      rejects('Conversation', 'findMany', { where: { AND: [{ companyId: companyA }] } });
    });

    it('aceita consulta com companyId no where (valor ou equals)', () => {
      for (const operation of ['findMany', 'findFirst', 'count', 'updateMany', 'deleteMany']) {
        run('Conversation', operation, { where: { companyId: companyA } });
        run('Conversation', operation, { where: { companyId: { equals: companyA } } });
        run('Conversation', operation, { where: { id: randomUUID(), companyId: companyA } });
      }
    });

    it('proíbe findUnique, findUniqueOrThrow, update, delete e upsert, mesmo com companyId', () => {
      for (const operation of ['findUnique', 'findUniqueOrThrow', 'update', 'delete', 'upsert']) {
        rejects('Conversation', operation, { where: { id: randomUUID() } });
        rejects('Conversation', operation, { where: { id: randomUUID(), companyId: companyA } });
      }
    });

    it('create e createMany exigem companyId em todos os registros', () => {
      rejects('Conversation', 'create', { data: {} });
      rejects('Conversation', 'create', { data: { companyId: undefined } });
      rejects('Conversation', 'create', {});
      rejects('Conversation', 'createMany', { data: [{ companyId: companyA }, {}] });
      rejects('Conversation', 'createMany', { data: [] });
      rejects('Conversation', 'createManyAndReturn', { data: {} });
      run('Conversation', 'create', { data: { companyId: companyA } });
      run('Conversation', 'createMany', {
        data: [{ companyId: companyA }, { companyId: companyB }],
      });
      run('Conversation', 'createManyAndReturn', { data: { companyId: companyA } });
    });

    it('create não aceita a empresa por relacionamento', () => {
      rejects('Conversation', 'create', {
        data: { companyId: companyA, company: { connect: { id: companyB } } },
      });
      rejects('Conversation', 'create', { data: { company: { connect: { id: companyB } } } });
    });

    it('updateMany não pode trocar a empresa do registro', () => {
      rejects('Conversation', 'updateMany', {
        where: { companyId: companyA },
        data: { companyId: companyB },
      });
      rejects('Conversation', 'updateMany', {
        where: { companyId: companyA },
        data: { company: { connect: { id: companyB } } },
      });
      run('Conversation', 'updateMany', { where: { companyId: companyA }, data: {} });
    });

    it('falha fechada: operação desconhecida não passa em model de tenant', () => {
      rejects('Conversation', 'findRaw', { where: { companyId: companyA } });
      rejects('Conversation', 'operacaoNova', { where: { companyId: companyA } });
    });

    it('a mensagem e o contexto dizem o model e a operação, sem valores dos argumentos', () => {
      try {
        run('Conversation', 'findMany', { where: { companyId: undefined, id: 'valor-secreto' } });
        assert.fail('deveria ter lançado');
      } catch (error) {
        assert.ok(error instanceof TenantScopeError);
        assert.deepEqual(Object.keys(error.context).sort(), ['model', 'operation', 'reason']);
        assert.ok(!JSON.stringify(error.context).includes('valor-secreto'));
        assert.ok(!error.message.includes('valor-secreto'));
      }
    });
  });

  describe('model de tenant (Message)', () => {
    const OPERATIONS_WITH_WHERE = ['findMany', 'findFirst', 'count', 'updateMany', 'deleteMany'];

    it('consulta sem companyId no where lança TenantScopeError', () => {
      for (const operation of OPERATIONS_WITH_WHERE) {
        rejects('Message', operation, {});
        rejects('Message', operation, { where: {} });
        rejects('Message', operation, { where: { conversationId: randomUUID() } });
        rejects('Message', operation, { where: { companyId: undefined, externalId: 'x' } });
      }
    });

    it('aceita as operações permitidas com companyId no where', () => {
      for (const operation of OPERATIONS_WITH_WHERE) {
        run('Message', operation, { where: { companyId: companyA, externalId: 'x' } });
      }
      run('Message', 'findMany', {
        where: { companyId: companyA, conversationId: randomUUID() },
        orderBy: [{ createdAt: 'desc' }],
        take: 5,
      });
    });

    it('operações por chave única são proibidas, mesmo com companyId', () => {
      for (const operation of ['findUnique', 'findUniqueOrThrow', 'update', 'delete', 'upsert']) {
        rejects('Message', operation, { where: { id: randomUUID() } });
        rejects('Message', operation, { where: { id: randomUUID(), companyId: companyA } });
      }
    });

    it('criação exige companyId nos dados (e não aceita relação company)', () => {
      rejects('Message', 'create', { data: { content: 'x' } });
      rejects('Message', 'create', {
        data: { content: 'x', company: { connect: { id: companyA } } },
      });
      rejects('Message', 'createMany', { data: [{ companyId: companyA }, { content: 'x' }] });
      run('Message', 'create', { data: { companyId: companyA, content: 'x' } });
    });
  });

  describe('model global (Company)', () => {
    it('não exige companyId e aceita operações por chave única', () => {
      for (const operation of [
        'findUnique',
        'findMany',
        'findFirst',
        'update',
        'create',
        'count',
      ]) {
        run('Company', operation, { where: { id: randomUUID() } });
      }
    });

    it('não deixa atravessar para dados de tenant por include, select ou _count', () => {
      rejects('Company', 'findMany', { include: { conversations: true } });
      rejects('Company', 'findFirst', {
        select: { id: true, conversations: { select: { id: true } } },
      });
      rejects('Company', 'findUnique', { where: { id: companyA }, include: { _count: true } });
      rejects('Company', 'findMany', {
        select: { _count: { select: { conversations: true } } },
      });
      rejects('Company', 'create', { data: { name: 'x' }, include: { conversations: true } });
      rejects('Company', 'findMany', { include: { messages: true } });
      rejects('Company', 'findMany', { select: { _count: { select: { messages: true } } } });
    });

    it('aceita select e include que não tocam dados de tenant', () => {
      run('Company', 'findMany', { select: { id: true, name: true, conversations: false } });
      run('Company', 'findMany', { include: { conversations: false } });
      run('Company', 'findMany', { select: { _count: { select: { conversations: false } } } });
    });
  });

  it('operação sem model (raw) não passa por esta verificação', () => {
    guard({ model: undefined, operation: '$queryRaw', args: undefined });
  });
});

describe('extensão no client do Prisma (sem banco)', () => {
  it('rejeita antes de ir ao banco: conversation.findMany({}) lança TenantScopeError', async () => {
    const extended = extendWithTenantScope(base);
    await assert.rejects(
      extended.conversation.findMany({}),
      (error: unknown) => error instanceof TenantScopeError,
    );
    await assert.rejects(
      extended.conversation.findUnique({ where: { id: randomUUID() } }),
      (error: unknown) => error instanceof TenantScopeError,
    );
  });
});
