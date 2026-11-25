import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Prisma } from '../../../generated/prisma/client.js';
import type { TenantScopedPrisma } from '../extensions/tenant-scope.js';
import {
  DEADLOCK_RETRIES,
  PrismaPlatformAccountUnitOfWork,
} from './platform-account-unit-of-work.js';

// Spec 045, E2 (revisão): um deadlock (40P01) num `$queryRaw` do Prisma 7 não chega como P2034. O
// `createCompany` da 031 já trava na mesma ordem (empresas, depois a conta); como defesa, a unidade de
// trabalho repete a transação inteira em deadlock (só nele).

function adapterError(sqlState: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('falha', {
    code: 'P2010',
    clientVersion: 'test',
    meta: { driverAdapterError: { cause: { originalCode: sqlState } } },
  });
}

/** Prisma falso: só `$transaction`, que falha com os erros dados e depois roda o callback. */
function fakePrisma(failures: Error[]): { prisma: TenantScopedPrisma; calls: () => number } {
  let calls = 0;
  const prisma = {
    $transaction: async (fn: (db: unknown) => Promise<unknown>) => {
      calls += 1;
      const failure = failures.shift();
      if (failure !== undefined) throw failure;
      return fn({});
    },
  } as unknown as TenantScopedPrisma;
  return { prisma, calls: () => calls };
}

const NO_WAIT = { maxRetries: 0, sleep: () => Promise.resolve() };

describe('PrismaPlatformAccountUnitOfWork: deadlock (spec 045, E2)', () => {
  it('repete a transação inteira depois de um deadlock e devolve o resultado', async () => {
    const fake = fakePrisma([adapterError('40P01')]);
    const uow = new PrismaPlatformAccountUnitOfWork(fake.prisma, NO_WAIT);
    let runs = 0;
    const result = await uow.run(() => {
      runs += 1;
      return Promise.resolve('ok');
    });
    assert.equal(result, 'ok');
    assert.equal(fake.calls(), 2);
    assert.equal(runs, 1, 'o callback só roda na tentativa que abriu');
  });

  it(`desiste depois de ${String(DEADLOCK_RETRIES)} repetições; outro erro de banco não é repetido`, async () => {
    const always = fakePrisma(
      Array.from({ length: DEADLOCK_RETRIES + 1 }, () => adapterError('40P01')),
    );
    await assert.rejects(
      new PrismaPlatformAccountUnitOfWork(always.prisma, NO_WAIT).run(() => Promise.resolve(1)),
    );
    assert.equal(always.calls(), DEADLOCK_RETRIES + 1);

    const other = fakePrisma([adapterError('23505')]);
    await assert.rejects(
      new PrismaPlatformAccountUnitOfWork(other.prisma, NO_WAIT).run(() => Promise.resolve(1)),
    );
    assert.equal(other.calls(), 1);
  });
});
