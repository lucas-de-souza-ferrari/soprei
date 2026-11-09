import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AccountId,
  CompanyId,
  type AccountRepository,
  type CompanyBillingPolicy,
  MembershipId,
} from '../../domain/index.js';
import { ForbiddenError } from '../../shared/errors/index.js';
import { FakePasswordHasher, InMemorySessionStore } from '../../test-support/in-memory-auth.js';
import { noResetMail } from '../../test-support/no-reset-mail.js';
import { AccountService } from './account.service.js';

// Spec 031: o service só repassa a política de cobrança (com o relógio do service); quem a aplica é o
// repositório, na transação que trava a conta (provado contra o Postgres em billing.integration.test.ts).
const ACCOUNT = '01900000-0000-7000-8000-0000000000a1';
const NOW = new Date('2026-11-10T12:00:00.000Z');

function harness(billing?: { trialDays: number; graceDays: number }, fail?: ForbiddenError) {
  const calls: { name: string; policy: CompanyBillingPolicy | undefined }[] = [];
  const accounts = {
    findById: () =>
      Promise.resolve({
        id: AccountId.parse(ACCOUNT),
        email: 'a@exemplo.test',
        passwordHash: 'x',
        status: 'ACTIVE' as const,
        emailVerifiedAt: NOW,
      }),
    createCompany: (_account: string, name: string, policy?: CompanyBillingPolicy) => {
      calls.push({ name, policy });
      if (fail !== undefined) return Promise.reject(fail);
      return Promise.resolve({
        companyId: CompanyId.parse('01900000-0000-7000-8000-0000000000c1'),
        membershipId: MembershipId.parse('01900000-0000-7000-8000-0000000000d1'),
        name,
        role: 'OWNER' as const,
      });
    },
  } as unknown as AccountRepository;
  const service = new AccountService({
    accounts,
    passwords: new FakePasswordHasher(),
    sessions: {
      create: () => Promise.resolve('s'),
      read: () =>
        Promise.resolve({
          accountId: ACCOUNT,
          id: 'sess',
          companyId: null,
          createdAt: NOW.getTime(),
        }),
      select: () => Promise.resolve(),
      revoke: () => Promise.resolve(),
      revokeAll: () => Promise.resolve(),
    },
    mailer: { ...noResetMail, sendVerification: () => Promise.resolve() },
    loginLocks: new InMemorySessionStore({ now: () => NOW }),
    loginSecret: 'segredo-de-teste-com-mais-de-32-caracteres-0123456789',
    now: () => NOW,
    ...(billing === undefined ? {} : { billing }),
  });
  return { service, calls };
}

test('sem a cobrança (BILLING_ENABLED=false) o repositório recebe a criação sem política: comportamento de antes', async () => {
  const { service, calls } = harness();
  const created = await service.createCompany('x'.repeat(43), 'Minha empresa');
  assert.equal(created.role, 'OWNER');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.policy, undefined);
});

test('com a cobrança, a política leva o relógio do service e as configurações; a recusa do plano sobe como está', async () => {
  const ok = harness({ trialDays: 7, graceDays: 5 });
  await ok.service.createCompany('x'.repeat(43), 'Minha empresa');
  assert.deepEqual(ok.calls[0]?.policy, { trialDays: 7, graceDays: 5, now: NOW });

  const limit = new ForbiddenError('Limite de empresas do plano atingido', {
    code: 'PLAN_COMPANY_LIMIT',
  });
  const blocked = harness({ trialDays: 7, graceDays: 5 }, limit);
  await assert.rejects(
    () => blocked.service.createCompany('x'.repeat(43), 'Outra'),
    (error: unknown) => error instanceof ForbiddenError && error.code === 'PLAN_COMPANY_LIMIT',
  );
});
