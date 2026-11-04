import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { type Company } from '../../../domain/index.js';
import { TenantScopeError } from '../../../shared/errors/index.js';
import { loadIntegrationConfig } from '../../../test-support/integration-env.js';
import { TestTenants } from '../../../test-support/tenant-fixtures.js';
import { createLogger } from '../../logger/logger.js';
import { createDatabase, type Database } from '../database.js';
import { runInTransaction } from '../transaction.js';
import type { TenantScopedDb } from './tenant-scope.js';

const config = loadIntegrationConfig();

let database: Database;
let tenants: TestTenants;
let companyA: Company;
let companyB: Company;
let conversationB: string;

const isTenantScopeError = (error: unknown): boolean => error instanceof TenantScopeError;

before(async () => {
  database = createDatabase(config, createLogger(config));
  tenants = new TestTenants(database.prisma);
  companyA = await tenants.createCompany('scope-a');
  companyB = await tenants.createCompany('scope-b');
  await database.prisma.conversation.create({
    data: { companyId: companyA.id, contactRef: randomUUID() },
  });
  conversationB = (
    await database.prisma.conversation.create({
      data: { companyId: companyB.id, contactRef: randomUUID() },
    })
  ).id;
});

after(async () => {
  try {
    await tenants.cleanup();
  } finally {
    await database.close();
  }
});

/** Cada chamada abaixo é type-válida no Prisma; só a segunda barreira as impede. */
function unscopedCalls(db: TenantScopedDb): readonly (readonly [string, () => Promise<unknown>])[] {
  const id = conversationB;
  return [
    ['findMany({})', () => db.conversation.findMany({})],
    ['findFirst({})', () => db.conversation.findFirst({})],
    ['count({})', () => db.conversation.count({})],
    ['deleteMany({})', () => db.conversation.deleteMany({})],
    ['updateMany sem where', () => db.conversation.updateMany({ data: { updatedAt: new Date() } })],
    ['findUnique', () => db.conversation.findUnique({ where: { id } })],
    ['findUniqueOrThrow', () => db.conversation.findUniqueOrThrow({ where: { id } })],
    ['update', () => db.conversation.update({ where: { id }, data: { updatedAt: new Date() } })],
    ['delete', () => db.conversation.delete({ where: { id } })],
    [
      'upsert',
      () =>
        db.conversation.upsert({
          where: { id },
          create: { companyId: companyA.id, contactRef: randomUUID() },
          update: {},
        }),
    ],
    ['companyId undefined', () => db.conversation.findMany({ where: { companyId: undefined } })],
    [
      'create sem companyId (via relação)',
      () =>
        db.conversation.create({
          data: { contactRef: randomUUID(), company: { connect: { id: companyA.id } } },
        }),
    ],
  ];
}

describe('segunda barreira contra o banco real', () => {
  it('prisma.conversation.findMany({}) lança TenantScopeError', async () => {
    await assert.rejects(database.prisma.conversation.findMany({}), isTenantScopeError);
  });

  it('findMany, findUnique, update, delete, upsert e demais chamadas sem escopo lançam', async () => {
    for (const [label, call] of unscopedCalls(database.prisma)) {
      await assert.rejects(call(), isTenantScopeError, label);
    }
  });

  it('o mesmo vale dentro de runInTransaction (e o erro desfaz a transação)', async () => {
    await assert.rejects(
      runInTransaction(database.prisma, async (tx) => {
        await tx.conversation.create({
          data: { companyId: companyA.id, contactRef: randomUUID() },
        });
        for (const [label, call] of unscopedCalls(tx)) {
          await assert.rejects(call(), isTenantScopeError, `tx: ${label}`);
        }
        await tx.conversation.findMany({});
      }),
      isTenantScopeError,
    );
    // A criação feita antes do erro, dentro da transação, foi desfeita.
    assert.equal(
      await database.prisma.conversation.count({ where: { companyId: companyA.id } }),
      1,
    );
  });

  it('nada foi alterado no banco pelas chamadas recusadas', async () => {
    assert.equal(
      await database.prisma.conversation.count({ where: { companyId: companyB.id } }),
      1,
    );
    assert.ok(
      await database.prisma.conversation.findFirst({
        where: { id: conversationB, companyId: companyB.id },
      }),
    );
  });

  it('com companyId no where as operações funcionam e só enxergam a empresa informado', async () => {
    const db = database.prisma;
    assert.equal(await db.conversation.count({ where: { companyId: companyA.id } }), 1);
    assert.equal(
      await db.conversation.findFirst({ where: { id: conversationB, companyId: companyA.id } }),
      null,
    );
    const { count } = await db.conversation.updateMany({
      where: { id: conversationB, companyId: companyA.id },
      data: { updatedAt: new Date() },
    });
    assert.equal(count, 0);
    const inTx = await runInTransaction(database.prisma, (tx) =>
      tx.conversation.findMany({ where: { companyId: companyB.id } }),
    );
    assert.deepEqual(
      inTx.map((row) => row.id),
      [conversationB],
    );
  });

  it('não deixa ler conversas de todos as empresas pelo model global (include no Company)', async () => {
    await assert.rejects(
      database.prisma.company.findMany({ include: { conversations: true } }),
      isTenantScopeError,
    );
    await assert.rejects(
      database.prisma.company.findFirst({
        select: { _count: { select: { conversations: true } } },
      }),
      isTenantScopeError,
    );
    const plain = await database.prisma.company.findFirst({ where: { id: companyA.id } });
    assert.equal(plain?.id, companyA.id);
  });

  it('o model global Company segue com findUnique e update (é a raiz, sem companyId)', async () => {
    const found = await database.prisma.company.findUnique({ where: { id: companyA.id } });
    assert.equal(found?.slug, companyA.slug);
    const updated = await database.prisma.company.update({
      where: { id: companyA.id },
      data: { name: 'Renomeado' },
    });
    assert.equal(updated.name, 'Renomeado');
  });

  it('SQL cru e check() não são afetados (o lint é quem restringe o SQL cru)', async () => {
    const rows = await database.prisma.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok`;
    assert.equal(rows[0]?.ok, 1);
    assert.ok((await database.check()).ok);
  });

  it('o erro não carrega SQL nem os valores dos argumentos', async () => {
    const secret = randomUUID();
    try {
      await database.prisma.conversation.findMany({ where: { id: secret } });
      assert.fail('deveria ter lançado');
    } catch (error) {
      assert.ok(error instanceof TenantScopeError);
      assert.ok(!error.message.includes(secret));
      assert.ok(!JSON.stringify(error.context).includes(secret));
      assert.ok(!error.message.toUpperCase().includes('SELECT'));
    }
  });
});
