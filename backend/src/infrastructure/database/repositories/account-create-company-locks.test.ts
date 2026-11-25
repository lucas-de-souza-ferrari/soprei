import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CompanyBillingPolicy } from '../../../domain/repositories/billing.repository.js';
import type { TenantScopedPrisma } from '../extensions/tenant-scope.js';
import { PrismaAccountRepository } from './account.repository.js';

// Spec 045, E2 (revisão, decisão do dono em 2026-11-25): a criação de empresa com a cobrança ligada (031)
// adota as empresas em que a conta é dona e por isso as trava ANTES da conta, na mesma ordem das ações da
// plataforma sobre a conta (empresas, depois a conta). Ordem invertida entre as duas dava deadlock.

const ACCOUNT = '01a20eda-0000-7000-8000-000000000001';
const OWNED = ['01a20eda-0000-7000-8000-0000000000b2', '01a20eda-0000-7000-8000-0000000000a1'];

/** Prisma falso que registra a ordem das travas; a conta vem desativada, então a criação para ali. */
function fakeDb(): { db: TenantScopedPrisma; order: string[] } {
  const order: string[] = [];
  const tx = {
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('FROM accounts')) order.push('account');
      else if (sql.includes('FROM companies')) order.push(`company:${String(values[0])}`);
      return Promise.resolve([{ id: values[0] }]);
    },
    company: {
      findMany: () => Promise.resolve([...OWNED].sort().map((id) => ({ id }))),
    },
    account: {
      findUnique: () =>
        Promise.resolve({ id: ACCOUNT, status: 'DISABLED', emailVerifiedAt: new Date() }),
    },
  };
  const db = {
    $transaction: (fn: (inner: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as TenantScopedPrisma;
  return { db, order };
}

const billing = {
  now: new Date('2026-11-25T12:00:00Z'),
  graceDays: 7,
} as unknown as CompanyBillingPolicy;

describe('createCompany: ordem das travas (spec 045, E2, revisão)', () => {
  it('com a cobrança ligada, trava as empresas da conta (em ordem de id) antes da conta', async () => {
    const { db, order } = fakeDb();
    await assert.rejects(new PrismaAccountRepository(db).createCompany(ACCOUNT, 'Nova', billing));
    assert.deepEqual(order, [...[...OWNED].sort().map((id) => `company:${id}`), 'account']);
  });

  it('com a cobrança desligada, não adota nada e trava só a conta', async () => {
    const { db, order } = fakeDb();
    await assert.rejects(new PrismaAccountRepository(db).createCompany(ACCOUNT, 'Nova'));
    assert.deepEqual(order, ['account']);
  });
});
