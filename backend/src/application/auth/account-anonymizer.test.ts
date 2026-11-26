import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  AccountId,
  CompanyId,
  MembershipId,
  type NewPlatformAuditEvent,
  PlatformAdminId,
} from '../../domain/index.js';
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from '../../shared/errors/index.js';
import { captureLogs, logContains } from '../../test-support/log-capture.js';
import type {
  AccountAnonymizationTransaction,
  AccountAnonymizationUnitOfWork,
  AnonymizedMembershipRef,
} from '../ports/account-anonymization-unit-of-work.js';
import { AccountAnonymizer, isAnonymizedEmail } from './account-anonymizer.js';

const EMAIL = 'pessoa.secreta@exemplo.com';

interface StoredAccount {
  email: string;
  status: 'ACTIVE' | 'DISABLED';
  verified: boolean;
  memberships: { ref: AnonymizedMembershipRef; email: string; status: 'ACTIVE' | 'DISABLED' }[];
}

/** Unidade de trabalho em memória: grava só no fim (como o commit) e registra as chamadas em ordem. */
class InMemoryAnonymization implements AccountAnonymizationUnitOfWork {
  readonly accounts = new Map<string, StoredAccount>();
  readonly events: NewPlatformAuditEvent[] = [];
  soleOwner = 0;
  paid = false;
  failAudit = false;
  /** Simula outro pedido que anonimiza entre a pré-checagem e a transação principal. */
  concurrent: ((staged: Map<string, StoredAccount>) => void) | undefined = undefined;

  constructor(private readonly calls: string[]) {}

  async run<T>(fn: (tx: AccountAnonymizationTransaction) => Promise<T>): Promise<T> {
    const staged = new Map(
      [...this.accounts].map(([id, a]) => [
        id,
        { ...a, memberships: a.memberships.map((m) => ({ ...m })) },
      ]),
    );
    const events: NewPlatformAuditEvent[] = [];
    const result = await fn({
      lockMemberCompanies: () => {
        this.calls.push('lock:companies');
        this.concurrent?.(staged);
        return Promise.resolve(0);
      },
      lockAccount: (accountId) => {
        this.calls.push('lock:account');
        const account = staged.get(accountId);
        return Promise.resolve(
          account === undefined
            ? null
            : { email: account.email, status: account.status, verified: account.verified },
        );
      },
      soleOwnerCompanies: () => Promise.resolve(this.soleOwner),
      paidInForce: () => Promise.resolve(this.paid),
      anonymize: (accountId, email) => {
        this.calls.push('anonymize');
        const account = staged.get(accountId);
        if (account === undefined) return Promise.resolve([]);
        account.email = email;
        account.status = 'DISABLED';
        for (const m of account.memberships) {
          m.email = email;
          m.status = 'DISABLED';
        }
        return Promise.resolve(account.memberships.map((m) => m.ref));
      },
      memberships: (accountId) =>
        Promise.resolve((staged.get(accountId)?.memberships ?? []).map((m) => m.ref)),
      platformAudit: (event) => {
        if (this.failAudit) return Promise.reject(new Error('trilha indisponível'));
        events.push(event);
        return Promise.resolve();
      },
    });
    for (const [id, a] of staged) this.accounts.set(id, a);
    this.events.push(...events);
    return result;
  }
}

function setup() {
  const calls: string[] = [];
  const uow = new InMemoryAnonymization(calls);
  const accountId = AccountId.parse(randomUUID());
  const other = AccountId.parse(randomUUID());
  const ref = (): AnonymizedMembershipRef => ({
    companyId: CompanyId.parse(randomUUID()),
    membershipId: MembershipId.parse(randomUUID()),
  });
  uow.accounts.set(accountId, {
    email: EMAIL,
    status: 'ACTIVE',
    verified: true,
    memberships: [
      { ref: ref(), email: EMAIL, status: 'ACTIVE' },
      { ref: ref(), email: EMAIL, status: 'ACTIVE' },
    ],
  });
  uow.accounts.set(other, {
    email: 'outra@exemplo.com',
    status: 'ACTIVE',
    verified: true,
    memberships: [{ ref: ref(), email: 'outra@exemplo.com', status: 'ACTIVE' }],
  });
  const mails: string[] = [];
  const logs = captureLogs();
  const state = { redisDown: false, mailFails: false, redisDownAfter: false };
  const anonymizer = new AccountAnonymizer({
    accounts: uow,
    accountSessions: {
      revokeAll: (id) => {
        calls.push(`revokeAll:${id}`);
        return state.redisDown || (state.redisDownAfter && calls.includes('anonymize'))
          ? Promise.reject(new ServiceUnavailableError('Sessão indisponível'))
          : Promise.resolve();
      },
    },
    bearerSessions: {
      revokeAllSessions: (scope, subject) => {
        calls.push(`bearer:${scope}:${subject}`);
        return Promise.resolve();
      },
    },
    mailer: {
      sendAccountDeleted: (email) => {
        mails.push(email);
        return state.mailFails ? Promise.reject(new Error('SMTP fora')) : Promise.resolve();
      },
    },
    logger: logs.logger,
  });
  return { uow, calls, accountId, other, mails, logs, state, anonymizer };
}

const conflict = (code: string) => (error: unknown) =>
  error instanceof ConflictError && error.code === code;

describe('AccountAnonymizer (spec 032 E7; spec 045 E6)', () => {
  it('única dona ativa = 409 COMPANY_OWNERSHIP; período pago = 409 SUBSCRIPTION_ACTIVE; nada muda e nenhuma sessão cai', async () => {
    const w = setup();
    w.uow.soleOwner = 1;
    await assert.rejects(w.anonymizer.anonymize(w.accountId), conflict('COMPANY_OWNERSHIP'));
    w.uow.soleOwner = 0;
    w.uow.paid = true;
    await assert.rejects(w.anonymizer.anonymize(w.accountId), conflict('SUBSCRIPTION_ACTIVE'));
    assert.equal(w.uow.accounts.get(w.accountId)?.email, EMAIL);
    assert.ok(!w.calls.some((call) => call.startsWith('revokeAll')));
    assert.deepEqual(w.mails, []);
  });

  it('Redis fora antes = 503 e nada anonimizado', async () => {
    const w = setup();
    w.state.redisDown = true;
    await assert.rejects(w.anonymizer.anonymize(w.accountId), ServiceUnavailableError);
    assert.equal(w.uow.accounts.get(w.accountId)?.email, EMAIL);
    assert.ok(!w.calls.includes('anonymize'));
  });

  it('sucesso: sessões fora antes, conta e vínculos anonimizados, trilha na transação, sessões de novo e das Bearer depois, aviso ao endereço antigo', async () => {
    const w = setup();
    const event: NewPlatformAuditEvent = {
      adminId: PlatformAdminId.parse(randomUUID()),
      action: 'ACCOUNT_ANONYMIZED',
      subjectAccountId: w.accountId,
      reason: 'OWNER_REQUEST',
    };
    assert.equal(await w.anonymizer.anonymize(w.accountId, { platformAudit: event }), true);
    await w.anonymizer.drain();
    const account = w.uow.accounts.get(w.accountId);
    assert.ok(account);
    assert.ok(isAnonymizedEmail(account.email));
    assert.equal(account.status, 'DISABLED');
    assert.ok(
      account.memberships.every((m) => m.email === account.email && m.status === 'DISABLED'),
    );
    // A outra conta nas mesmas condições não muda.
    assert.equal(w.uow.accounts.get(w.other)?.email, 'outra@exemplo.com');
    assert.deepEqual(w.uow.events, [event]);
    const firstRevoke = w.calls.indexOf(`revokeAll:${w.accountId}`);
    const anonymize = w.calls.indexOf('anonymize');
    assert.ok(firstRevoke >= 0 && firstRevoke < anonymize, 'revokeAll antes da transação');
    assert.ok(w.calls.lastIndexOf(`revokeAll:${w.accountId}`) > anonymize, 'e de novo depois');
    assert.equal(w.calls.filter((call) => call.startsWith('bearer:')).length, 2);
    // Na transação principal, as empresas antes da conta.
    const companies = w.calls.indexOf('lock:companies');
    assert.ok(companies >= 0 && w.calls[companies + 1] === 'lock:account');
    assert.deepEqual(w.mails, [EMAIL]);
    assert.ok(!logContains(w.logs.raw(), EMAIL), 'o e-mail nunca vai ao log');
  });

  it('repetir numa conta já anonimizada: false, refaz a revogação, sem evento nem e-mail', async () => {
    const w = setup();
    await w.anonymizer.anonymize(w.accountId);
    await w.anonymizer.drain();
    w.calls.length = 0;
    assert.equal(await w.anonymizer.anonymize(w.accountId), false);
    await w.anonymizer.drain();
    assert.ok(w.calls.includes(`revokeAll:${w.accountId}`));
    assert.equal(w.calls.filter((call) => call.startsWith('bearer:')).length, 2);
    assert.ok(!w.calls.includes('anonymize'));
    assert.deepEqual(w.mails, [EMAIL]);
  });

  it('trilha que falha: nada anonimizado; e-mail que falha não desfaz nada; conta inexistente = 404', async () => {
    const w = setup();
    w.uow.failAudit = true;
    await assert.rejects(
      w.anonymizer.anonymize(w.accountId, {
        platformAudit: {
          adminId: PlatformAdminId.parse(randomUUID()),
          action: 'ACCOUNT_ANONYMIZED',
          subjectAccountId: w.accountId,
        },
      }),
    );
    assert.equal(w.uow.accounts.get(w.accountId)?.email, EMAIL);
    assert.deepEqual(w.mails, []);

    const v = setup();
    v.state.mailFails = true;
    assert.equal(await v.anonymizer.anonymize(v.accountId), true);
    await v.anonymizer.drain();
    assert.ok(isAnonymizedEmail(v.uow.accounts.get(v.accountId)?.email ?? ''));

    await assert.rejects(v.anonymizer.anonymize(AccountId.parse(randomUUID())), NotFoundError);
  });

  it('pedido simultâneo anonimizou entre a pré-checagem e a transação: false, sem segundo evento, e-mail nem regravação', async () => {
    const w = setup();
    w.uow.concurrent = (staged) => {
      const account = staged.get(w.accountId);
      if (account !== undefined) account.email = 'removida-outro@excluido.invalid';
    };
    const committed: string[] = [];
    assert.equal(
      await w.anonymizer.anonymize(w.accountId, {
        platformAudit: {
          adminId: PlatformAdminId.parse(randomUUID()),
          action: 'ACCOUNT_ANONYMIZED',
          subjectAccountId: w.accountId,
        },
        onCommitted: () => committed.push('x'),
      }),
      false,
    );
    await w.anonymizer.drain();
    assert.equal(w.uow.accounts.get(w.accountId)?.email, 'removida-outro@excluido.invalid');
    assert.ok(!w.calls.includes('anonymize'));
    assert.deepEqual(w.uow.events, []);
    assert.deepEqual(w.mails, []);
    assert.deepEqual(committed, []);
    assert.equal(w.calls.filter((call) => call.startsWith('bearer:')).length, 2);
  });

  it('Redis fora depois do commit: 503 com a conta anonimizada e a ação já registrada (onCommitted); repetir conclui a revogação', async () => {
    const w = setup();
    w.state.redisDownAfter = true;
    const committed: string[] = [];
    await assert.rejects(
      w.anonymizer.anonymize(w.accountId, { onCommitted: () => committed.push('x') }),
      ServiceUnavailableError,
    );
    assert.ok(isAnonymizedEmail(w.uow.accounts.get(w.accountId)?.email ?? ''));
    assert.deepEqual(committed, ['x']);
    w.state.redisDownAfter = false;
    w.calls.length = 0;
    assert.equal(await w.anonymizer.anonymize(w.accountId), false);
    assert.equal(w.calls.filter((call) => call.startsWith('bearer:')).length, 2);
    assert.deepEqual(committed, ['x']);
  });

  it('conta não confirmada: anonimiza, mas o aviso não sai (endereço nunca comprovado)', async () => {
    const w = setup();
    const account = w.uow.accounts.get(w.accountId);
    assert.ok(account);
    account.verified = false;
    assert.equal(await w.anonymizer.anonymize(w.accountId), true);
    await w.anonymizer.drain();
    assert.ok(isAnonymizedEmail(w.uow.accounts.get(w.accountId)?.email ?? ''));
    assert.deepEqual(w.mails, []);
  });
});
