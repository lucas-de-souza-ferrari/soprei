import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccountService } from '../../application/auth/account.service.js';
import { pickCompanyToOpen } from '../../application/auth/company-pick.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { noResetMail } from '../../test-support/no-reset-mail.js';
import { TestKeyspace } from '../../test-support/test-keyspace.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import { createDatabase, PrismaAccountRepository } from '../database/index.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { createAuthRedis } from '../auth/auth-redis.js';
import { createAuthComponents } from '../auth/create-auth.js';
import { ScryptPasswordHasher } from '../auth/scrypt-password-hasher.js';
import { versionedAuthPrefix } from '../auth/auth-version.js';
import { RedisAccountSessionStore } from '../auth/redis-account-session-store.js';
import type { AccountRepository } from '../../domain/index.js';

/** Spec 029 (E2): a empresa abre sozinha no login (última usada) e a dica vive em `accounts.last_company_id`. */

const config = loadIntegrationConfig();
const PASSWORD = 'Senha1-teste';

async function withWorld(
  run: (world: {
    service: (accounts?: AccountRepository) => AccountService;
    repo: PrismaAccountRepository;
    db: ReturnType<typeof createDatabase>;
    warnings: string[];
    newAccount: (label: string) => Promise<{ id: string; email: string }>;
    newCompany: (accountId: string, email: string) => Promise<string>;
  }) => Promise<void>,
): Promise<void> {
  const logs = captureLogs();
  const db = createDatabase(config, logs.logger);
  const tenants = new TestTenants(db.prisma);
  const keys = new TestKeyspace();
  const prefix = keys.scopedPrefix('last-company');
  const redis = createAuthRedis(config, logs.logger);
  assert.ok(await redis.waitUntilReady(5000));
  const passwords = new ScryptPasswordHasher({ cost: { N: 1024, r: 8, p: 1 } });
  const auth = createAuthComponents({
    config: { ...config, ACCOUNTS_ENABLED: true, AUTH_REDIS_PREFIX: prefix },
    logger: logs.logger,
    prisma: db.prisma,
    authRedis: redis,
    hasher: passwords,
  });
  const repo = new PrismaAccountRepository(db.prisma);
  const sessions = new RedisAccountSessionStore(redis.client, versionedAuthPrefix(prefix, true));
  const warnings: string[] = [];
  const emails: string[] = [];
  try {
    await run({
      service: (accounts = repo) =>
        new AccountService({
          accounts,
          passwords,
          sessions,
          loginLocks: auth.sessions,
          loginSecret: config.JWT_SECRET,
          mailer: { ...noResetMail, sendVerification: () => Promise.resolve() },
          onWarning: (event) => warnings.push(event),
        }),
      repo,
      db,
      warnings,
      newAccount: async (label) => {
        const email = `${label}-${randomUUID()}@example.test`;
        emails.push(email);
        const account = await repo.create(email, await passwords.hash(PASSWORD));
        await db.prisma.account.updateMany({
          where: { id: account.id },
          data: { emailVerifiedAt: new Date() },
        });
        return { id: account.id, email };
      },
      newCompany: async (accountId, email) => {
        const company = await tenants.createCompany('last-company');
        await db.prisma.membership.create({
          data: {
            companyId: company.id,
            accountId,
            email,
            passwordHash: 'account-managed',
            role: 'OWNER',
          },
        });
        return company.id;
      },
    });
  } finally {
    await tenants.cleanup();
    await db.prisma.account.deleteMany({ where: { email: { in: emails } } });
    await keys.cleanup(redis.client);
    await redis.close();
    await db.close();
  }
}

const selectedAfterLogin = async (service: AccountService, email: string): Promise<string | null> =>
  (await service.me(await service.login(email, PASSWORD))).selectedCompanyId;

test('pickCompanyToOpen: última usada válida, senão a primeira, senão nada', () => {
  const list = [{ companyId: 'a' }, { companyId: 'b' }, { companyId: 'c' }];
  assert.equal(pickCompanyToOpen(list, 'b'), 'b');
  assert.equal(pickCompanyToOpen(list, null), 'a');
  assert.equal(pickCompanyToOpen(list, 'fora'), 'a');
  assert.equal(pickCompanyToOpen([{ companyId: 'z' }], 'fora'), 'z');
  assert.equal(pickCompanyToOpen([], 'a'), null);
  assert.equal(pickCompanyToOpen([], null), null);
});

test('login abre a última usada; sem uso, a primeira da lista; selecionar grava a dica', async () => {
  await withWorld(async ({ service, repo, newAccount, newCompany }) => {
    const svc = service();
    const account = await newAccount('multi');
    const first = await newCompany(account.id, account.email);
    const second = await newCompany(account.id, account.email);
    // Nunca usou nenhuma: a primeira da lista (D3).
    assert.equal(await repo.lastCompanyId(account.id), null);
    assert.equal(await selectedAfterLogin(svc, account.email), [first, second].sort()[0]);
    // Seleciona a segunda: a dica é gravada e o próximo login abre a segunda.
    const secret = await svc.login(account.email, PASSWORD);
    await svc.selectCompany(secret, second);
    assert.equal(await repo.lastCompanyId(account.id), second);
    assert.equal(await selectedAfterLogin(svc, account.email), second);
    // Trocar de novo vira a nova última usada.
    await svc.selectCompany(secret, first);
    assert.equal(await selectedAfterLogin(svc, account.email), first);
  });
});

test('uma só empresa: pré-seleciona; nenhuma: sessão sem empresa', async () => {
  await withWorld(async ({ service, newAccount, newCompany }) => {
    const svc = service();
    const one = await newAccount('one');
    const company = await newCompany(one.id, one.email);
    assert.equal(await selectedAfterLogin(svc, one.email), company);
    const none = await newAccount('none');
    assert.equal(await selectedAfterLogin(svc, none.email), null);
  });
});

test('a última usada suspensa, removida ou com vínculo desativado é ignorada', async () => {
  await withWorld(async ({ service, db, newAccount, newCompany }) => {
    const svc = service();
    const account = await newAccount('stale');
    const keep = await newCompany(account.id, account.email);
    const gone = await newCompany(account.id, account.email);
    const hint = async (companyId: string) => {
      const secret = await svc.login(account.email, PASSWORD);
      await svc.selectCompany(secret, companyId);
    };

    await hint(gone);
    await db.prisma.company.update({ where: { id: gone }, data: { status: 'SUSPENDED' } });
    assert.equal(await selectedAfterLogin(svc, account.email), keep);
    await db.prisma.company.update({ where: { id: gone }, data: { status: 'ACTIVE' } });

    assert.equal(await selectedAfterLogin(svc, account.email), gone);
    await db.prisma.company.update({ where: { id: gone }, data: { deletedAt: new Date() } });
    assert.equal(await selectedAfterLogin(svc, account.email), keep);
    await db.prisma.company.update({ where: { id: gone }, data: { deletedAt: null } });

    assert.equal(await selectedAfterLogin(svc, account.email), gone);
    await db.prisma.membership.updateMany({
      where: { companyId: gone, accountId: account.id },
      data: { status: 'DISABLED' },
    });
    assert.equal(await selectedAfterLogin(svc, account.email), keep);

    // Só sobra uma e ela também está inutilizável: nenhuma.
    await db.prisma.company.update({ where: { id: keep }, data: { status: 'SUSPENDED' } });
    assert.equal(await selectedAfterLogin(svc, account.email), null);
  });
});

test('isolamento: a dica é da própria conta e nunca aponta para empresa alheia', async () => {
  await withWorld(async ({ service, repo, db, newAccount, newCompany }) => {
    const svc = service();
    const alice = await newAccount('alice');
    const bob = await newAccount('bob');
    const aliceCompany = await newCompany(alice.id, alice.email);
    const bobCompany = await newCompany(bob.id, bob.email);
    const aliceSecret = await svc.login(alice.email, PASSWORD);
    await svc.selectCompany(aliceSecret, aliceCompany);

    // Selecionar empresa alheia continua 404 e não mexe na dica.
    await assert.rejects(svc.selectCompany(aliceSecret, bobCompany), { statusCode: 404 });
    assert.equal(await repo.lastCompanyId(alice.id), aliceCompany);
    assert.equal(await repo.lastCompanyId(bob.id), null);

    // Mesmo com a dica de Bob adulterada para uma empresa em que ele não é membro, o login a ignora.
    await db.prisma.account.updateMany({
      where: { id: bob.id },
      data: { lastCompanyId: aliceCompany },
    });
    assert.equal(await selectedAfterLogin(svc, bob.email), bobCompany);
    // E a dica de Bob nunca vaza para Alice.
    assert.equal(await selectedAfterLogin(svc, alice.email), aliceCompany);
  });
});

test('empresa removida de verdade zera a dica (ON DELETE SET NULL)', async () => {
  await withWorld(async ({ service, repo, db, newAccount, newCompany }) => {
    const svc = service();
    const account = await newAccount('setnull');
    const company = await newCompany(account.id, account.email);
    await svc.selectCompany(await svc.login(account.email, PASSWORD), company);
    assert.equal(await repo.lastCompanyId(account.id), company);
    // Mesma ordem do `TestTenants.cleanup`: o vínculo antes da empresa.
    await db.prisma.membership.deleteMany({ where: { companyId: company } });
    await db.prisma.company.deleteMany({ where: { id: company } });
    assert.equal(await repo.lastCompanyId(account.id), null);
  });
});

test('falha ao gravar ou ler a dica não derruba o login nem o select', async () => {
  await withWorld(async ({ service, repo, warnings, newAccount, newCompany }) => {
    const account = await newAccount('broken');
    const company = await newCompany(account.id, account.email);
    const broken = Object.create(repo) as AccountRepository;
    Object.assign(broken, {
      lastCompanyId: () => Promise.reject(new Error('falha simulada')),
      setLastCompany: () => Promise.reject(new Error('falha simulada')),
    });
    const svc = service(broken);
    // Pré-seleção falha: o login segue e a sessão fica sem empresa, como antes.
    const secret = await svc.login(account.email, PASSWORD);
    assert.equal((await svc.me(secret)).selectedCompanyId, null);
    // Gravar a dica falha: o select já feito vale.
    await svc.selectCompany(secret, company);
    assert.equal((await svc.me(secret)).selectedCompanyId, company);
    assert.deepEqual(warnings, ['preselect_failed', 'last_company_failed']);
    assert.equal(await repo.lastCompanyId(account.id), null);
  });
});
