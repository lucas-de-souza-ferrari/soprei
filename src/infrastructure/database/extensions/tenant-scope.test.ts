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

const clientA = randomUUID();
const clientB = randomUUID();

describe('cobertura do registro de models (lê o schema gerado)', () => {
  it('todo model do schema está classificado como a presença de clientId manda', () => {
    assert.deepEqual(findScopeProblems(models, MODEL_SCOPES), []);
  });

  it('o registro lista exatamente os models que o Prisma gerou', () => {
    assert.deepEqual(Object.keys(MODEL_SCOPES).sort(), Object.keys(Prisma.ModelName).sort());
    assert.deepEqual(models.map((model) => model.name).sort(), Object.keys(MODEL_SCOPES).sort());
  });

  it('Conversation e Message são de tenant (têm clientId) e Client é global (raiz do tenant)', () => {
    assert.equal(MODEL_SCOPES.Conversation, 'tenant');
    assert.equal(MODEL_SCOPES.Message, 'tenant');
    const message = models.find((model) => model.name === 'Message');
    assert.ok(message?.fields.some((field) => field.name === 'clientId'));
    assert.equal(MODEL_SCOPES.Client, 'global');
    const conversation = models.find((model) => model.name === 'Conversation');
    assert.ok(conversation?.fields.some((field) => field.name === 'clientId'));
  });

  const ticket: ModelInfo = {
    name: 'Ticket',
    fields: [
      { name: 'id', kind: 'scalar', type: 'String' },
      { name: 'clientId', kind: 'scalar', type: 'String' },
    ],
  };
  const label: ModelInfo = {
    name: 'Label',
    fields: [{ name: 'id', kind: 'scalar', type: 'String' }],
  };

  it('falha se um model com clientId não está no registro de tenant', () => {
    const problems = findScopeProblems([...models, ticket], MODEL_SCOPES);
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /Ticket/);
    assert.throws(() => createTenantScopeGuard([...models, ticket]), /Ticket/);
  });

  it('falha se um model com clientId foi registrado como global', () => {
    const scopes: Record<string, ModelScope> = { ...MODEL_SCOPES, Ticket: 'global' };
    assert.match(findScopeProblems([...models, ticket], scopes).join(), /Ticket.*tenant/);
  });

  it('falha se um model sem clientId não está na lista de globais', () => {
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
    it('rejeita consulta sem clientId no where', () => {
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

    it('rejeita clientId que não é um valor definido (undefined, null, vazio, in, not, OR)', () => {
      rejects('Conversation', 'findMany', { where: { clientId: undefined } });
      rejects('Conversation', 'findMany', { where: { clientId: null } });
      rejects('Conversation', 'findMany', { where: { clientId: '' } });
      rejects('Conversation', 'findMany', { where: { clientId: { in: [clientA, clientB] } } });
      rejects('Conversation', 'findMany', { where: { clientId: { not: clientA } } });
      rejects('Conversation', 'findMany', { where: { clientId: { equals: undefined } } });
      rejects('Conversation', 'findMany', { where: { OR: [{ clientId: clientA }] } });
      rejects('Conversation', 'findMany', { where: { AND: [{ clientId: clientA }] } });
    });

    it('aceita consulta com clientId no where (valor ou equals)', () => {
      for (const operation of ['findMany', 'findFirst', 'count', 'updateMany', 'deleteMany']) {
        run('Conversation', operation, { where: { clientId: clientA } });
        run('Conversation', operation, { where: { clientId: { equals: clientA } } });
        run('Conversation', operation, { where: { id: randomUUID(), clientId: clientA } });
      }
    });

    it('proíbe findUnique, findUniqueOrThrow, update, delete e upsert, mesmo com clientId', () => {
      for (const operation of ['findUnique', 'findUniqueOrThrow', 'update', 'delete', 'upsert']) {
        rejects('Conversation', operation, { where: { id: randomUUID() } });
        rejects('Conversation', operation, { where: { id: randomUUID(), clientId: clientA } });
      }
    });

    it('create e createMany exigem clientId em todos os registros', () => {
      rejects('Conversation', 'create', { data: {} });
      rejects('Conversation', 'create', { data: { clientId: undefined } });
      rejects('Conversation', 'create', {});
      rejects('Conversation', 'createMany', { data: [{ clientId: clientA }, {}] });
      rejects('Conversation', 'createMany', { data: [] });
      rejects('Conversation', 'createManyAndReturn', { data: {} });
      run('Conversation', 'create', { data: { clientId: clientA } });
      run('Conversation', 'createMany', { data: [{ clientId: clientA }, { clientId: clientB }] });
      run('Conversation', 'createManyAndReturn', { data: { clientId: clientA } });
    });

    it('create não aceita o cliente por relacionamento', () => {
      rejects('Conversation', 'create', {
        data: { clientId: clientA, client: { connect: { id: clientB } } },
      });
      rejects('Conversation', 'create', { data: { client: { connect: { id: clientB } } } });
    });

    it('updateMany não pode trocar o cliente do registro', () => {
      rejects('Conversation', 'updateMany', {
        where: { clientId: clientA },
        data: { clientId: clientB },
      });
      rejects('Conversation', 'updateMany', {
        where: { clientId: clientA },
        data: { client: { connect: { id: clientB } } },
      });
      run('Conversation', 'updateMany', { where: { clientId: clientA }, data: {} });
    });

    it('falha fechada: operação desconhecida não passa em model de tenant', () => {
      rejects('Conversation', 'findRaw', { where: { clientId: clientA } });
      rejects('Conversation', 'operacaoNova', { where: { clientId: clientA } });
    });

    it('a mensagem e o contexto dizem o model e a operação, sem valores dos argumentos', () => {
      try {
        run('Conversation', 'findMany', { where: { clientId: undefined, id: 'valor-secreto' } });
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

    it('consulta sem clientId no where lança TenantScopeError', () => {
      for (const operation of OPERATIONS_WITH_WHERE) {
        rejects('Message', operation, {});
        rejects('Message', operation, { where: {} });
        rejects('Message', operation, { where: { conversationId: randomUUID() } });
        rejects('Message', operation, { where: { clientId: undefined, externalId: 'x' } });
      }
    });

    it('aceita as operações permitidas com clientId no where', () => {
      for (const operation of OPERATIONS_WITH_WHERE) {
        run('Message', operation, { where: { clientId: clientA, externalId: 'x' } });
      }
      run('Message', 'findMany', {
        where: { clientId: clientA, conversationId: randomUUID() },
        orderBy: [{ createdAt: 'desc' }],
        take: 5,
      });
    });

    it('operações por chave única são proibidas, mesmo com clientId', () => {
      for (const operation of ['findUnique', 'findUniqueOrThrow', 'update', 'delete', 'upsert']) {
        rejects('Message', operation, { where: { id: randomUUID() } });
        rejects('Message', operation, { where: { id: randomUUID(), clientId: clientA } });
      }
    });

    it('criação exige clientId nos dados (e não aceita relação client)', () => {
      rejects('Message', 'create', { data: { content: 'x' } });
      rejects('Message', 'create', {
        data: { content: 'x', client: { connect: { id: clientA } } },
      });
      rejects('Message', 'createMany', { data: [{ clientId: clientA }, { content: 'x' }] });
      run('Message', 'create', { data: { clientId: clientA, content: 'x' } });
    });
  });

  describe('model global (Client)', () => {
    it('não exige clientId e aceita operações por chave única', () => {
      for (const operation of [
        'findUnique',
        'findMany',
        'findFirst',
        'update',
        'create',
        'count',
      ]) {
        run('Client', operation, { where: { id: randomUUID() } });
      }
    });

    it('não deixa atravessar para dados de tenant por include, select ou _count', () => {
      rejects('Client', 'findMany', { include: { conversations: true } });
      rejects('Client', 'findFirst', {
        select: { id: true, conversations: { select: { id: true } } },
      });
      rejects('Client', 'findUnique', { where: { id: clientA }, include: { _count: true } });
      rejects('Client', 'findMany', {
        select: { _count: { select: { conversations: true } } },
      });
      rejects('Client', 'create', { data: { name: 'x' }, include: { conversations: true } });
      rejects('Client', 'findMany', { include: { messages: true } });
      rejects('Client', 'findMany', { select: { _count: { select: { messages: true } } } });
    });

    it('aceita select e include que não tocam dados de tenant', () => {
      run('Client', 'findMany', { select: { id: true, name: true, conversations: false } });
      run('Client', 'findMany', { include: { conversations: false } });
      run('Client', 'findMany', { select: { _count: { select: { conversations: false } } } });
    });
  });

  it('operação sem model (raw) não passa por esta verificação', () => {
    guard({ model: undefined, operation: '$queryRaw', args: undefined });
  });
});

describe('extensão no client (sem banco)', () => {
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
