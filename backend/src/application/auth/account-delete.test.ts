import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AccountId } from '../../domain/index.js';
import {
  ConflictError,
  NotFoundError,
  RateLimitError,
  UnauthorizedError,
} from '../../shared/errors/index.js';
import { InMemoryAccountRepository } from '../../test-support/in-memory-account.repository.js';
import { FakePasswordHasher, InMemorySessionStore } from '../../test-support/in-memory-auth.js';
import { noResetMail } from '../../test-support/no-reset-mail.js';
import type { AccountSessionStore } from '../ports/account-session.js';
import { AccountService } from './account.service.js';
import type { AnonymizeOptions } from './account-anonymizer.js';

const SECRET = 'segredo-de-teste-com-mais-de-32-caracteres-0123456789';
const PASSWORD = 'Senha1-valida';
const EMAIL = 'pessoa@example.test';
const COOKIE = 'sessao-da-pessoa';

/** Exclusão da própria conta (spec 032, E7): o `AccountService` confere cookie e senha e chama o núcleo. */
async function harness(options: { anonymizer?: false; refuse?: string } = {}) {
  const accounts = new InMemoryAccountRepository();
  await accounts.create(EMAIL, await new FakePasswordHasher().hash(PASSWORD));
  accounts.patch(EMAIL, { emailVerifiedAt: new Date('2026-11-27T12:00:00.000Z') });
  const row = accounts.peek(EMAIL);
  const sessions: AccountSessionStore = {
    create: () => Promise.resolve(COOKIE),
    read: (secret) =>
      Promise.resolve(
        secret === COOKIE ? { accountId: row.id, id: 's1', companyId: null, createdAt: 0 } : null,
      ),
    select: () => Promise.resolve(),
    revoke: () => Promise.resolve(),
    revokeAll: () => Promise.resolve(),
  };
  const calls: { accountId: AccountId; options: AnonymizeOptions | undefined }[] = [];
  const deleted: string[] = [];
  const locks = new InMemorySessionStore({ maxFailures: 3 });
  const service = new AccountService({
    accounts,
    passwords: new FakePasswordHasher(),
    sessions,
    mailer: { ...noResetMail, sendVerification: () => Promise.resolve() },
    loginLocks: locks,
    loginSecret: SECRET,
    onAccountDeleted: (accountId) => deleted.push(accountId),
    ...(options.anonymizer === false
      ? {}
      : {
          anonymizer: {
            anonymize: (accountId: AccountId, opts?: AnonymizeOptions) => {
              calls.push({ accountId, options: opts });
              if (options.refuse !== undefined) {
                return Promise.reject(new ConflictError('recusado', { code: options.refuse }));
              }
              accounts.patch(EMAIL, { status: 'DISABLED' });
              opts?.onCommitted?.();
              return Promise.resolve(true);
            },
          },
        }),
  });
  return { service, row, accounts, calls, deleted };
}

test('cookie e senha certos: chama o núcleo com o id da conta da sessão e registra a exclusão', async () => {
  const h = await harness();
  await h.service.deleteAccount(COOKIE, PASSWORD);
  assert.equal(h.calls.length, 1);
  const [call] = h.calls;
  assert.ok(call);
  assert.equal(call.accountId, h.row.id);
  // Sem trilha da plataforma: a pessoa exclui a própria conta.
  assert.equal(call.options?.platformAudit, undefined);
  assert.deepEqual(h.deleted, [h.row.id]);
  // A conta anonimizada não abre mais a sessão.
  await assert.rejects(h.service.me(COOKIE), UnauthorizedError);
});

test('senha errada = a 401 do login, sem chamar o núcleo, e conta no bloqueio por conta (429)', async () => {
  const h = await harness();
  for (let i = 0; i < 3; i++) {
    await assert.rejects(h.service.deleteAccount(COOKIE, 'Errada1-senha'), (error: unknown) => {
      assert.ok(error instanceof UnauthorizedError);
      assert.equal(error.message, 'Credenciais inválidas');
      return true;
    });
  }
  // Bloqueado: nem a senha certa passa, e o login também fica bloqueado (a mesma chave).
  await assert.rejects(h.service.deleteAccount(COOKIE, PASSWORD), RateLimitError);
  await assert.rejects(h.service.login(EMAIL, PASSWORD), RateLimitError);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.deleted, []);
});

test('sem cookie válido = 401 antes da senha; conta desativada = 401', async () => {
  const h = await harness();
  await assert.rejects(h.service.deleteAccount('outro', PASSWORD), UnauthorizedError);
  h.accounts.patch(EMAIL, { status: 'DISABLED' });
  await assert.rejects(h.service.deleteAccount(COOKIE, PASSWORD), UnauthorizedError);
  assert.equal(h.calls.length, 0);
});

test('recusa do núcleo (409) sobe sem registrar exclusão', async () => {
  for (const code of ['COMPANY_OWNERSHIP', 'SUBSCRIPTION_ACTIVE', 'ORDER_PENDING']) {
    const h = await harness({ refuse: code });
    await assert.rejects(h.service.deleteAccount(COOKIE, PASSWORD), (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.equal(error.code, code);
      return true;
    });
    assert.deepEqual(h.deleted, []);
    assert.equal(h.accounts.peek(EMAIL).status, 'ACTIVE');
  }
});

test('sem o núcleo ligado a rota responde 404', async () => {
  const h = await harness({ anonymizer: false });
  await assert.rejects(h.service.deleteAccount(COOKIE, PASSWORD), NotFoundError);
});
