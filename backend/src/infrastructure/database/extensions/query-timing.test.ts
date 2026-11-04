import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../../generated/prisma/client.js';
import { TenantScopeError } from '../../../shared/errors/index.js';
import { type QueryTimingSample, queryTimingExtension } from './query-timing.js';
import { extendWithTenantScope } from './tenant-scope.js';

// Pool de um destino inalcançável: o `pg` só conecta na primeira query. Toda operação que a
// tenant-scope deixar passar falha ao conectar, o que também prova que a medição cobre a
// ida ao banco mesmo quando ela falha.
const base = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: 'postgresql://u:p@127.0.0.1:1/db',
    connectionTimeoutMillis: 300,
  }),
});

after(async () => {
  await base.$disconnect();
});

function build(samples: QueryTimingSample[]) {
  return extendWithTenantScope(base).$extends(
    queryTimingExtension((sample) => {
      samples.push(sample);
    }),
  );
}

describe('extensão de tempo das queries (sem banco)', () => {
  it('a tenant-scope continua a primeira a rodar: operação sem escopo é rejeitada e nem chega a ser medida', async () => {
    const samples: QueryTimingSample[] = [];
    const db = build(samples);

    await assert.rejects(
      db.conversation.findMany({}),
      (error: unknown) => error instanceof TenantScopeError,
    );
    await assert.rejects(
      db.conversation.findUnique({ where: { id: randomUUID() } }),
      (error: unknown) => error instanceof TenantScopeError,
    );
    await assert.rejects(
      db.conversation.create({ data: {} as never }),
      (error: unknown) => error instanceof TenantScopeError,
    );
    assert.deepEqual(samples, []);
  });

  it('o que a barreira deixa passar é medido por model e operation, mesmo quando o banco falha', async () => {
    const samples: QueryTimingSample[] = [];
    const db = build(samples);

    await assert.rejects(db.conversation.findMany({ where: { companyId: randomUUID() } }));
    await assert.rejects(db.company.count());

    assert.deepEqual(
      samples.map(({ model, operation }) => ({ model, operation })),
      [
        { model: 'Conversation', operation: 'findMany' },
        { model: 'Company', operation: 'count' },
      ],
    );
    for (const sample of samples) {
      assert.equal(typeof sample.durationSeconds, 'number');
      assert.ok(sample.durationSeconds >= 0);
    }
  });
});
