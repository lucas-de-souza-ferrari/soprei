import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { AccountAnonymizer, isAnonymizedEmail } from '../../application/auth/account-anonymizer.js';
import { AccountService } from '../../application/auth/account.service.js';
import type { AccountSessionStore } from '../../application/ports/account-session.js';
import { AccountId, type Company } from '../../domain/index.js';
import { ServiceUnavailableError } from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { captureLogs, logContains } from '../../test-support/log-capture.js';
import { TestKeyspace } from '../../test-support/test-keyspace.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import { type AuthRedisHandle, createAuthRedis } from '../auth/auth-redis.js';
import { type AuthComponents, createAuthComponents } from '../auth/create-auth.js';
import { RedisAccountSessionStore } from '../auth/redis-account-session-store.js';
import { ScryptPasswordHasher } from '../auth/scrypt-password-hasher.js';
import {
  createDatabase,
  type Database,
  PrismaAccountAnonymizationUnitOfWork,
  PrismaAccountRepository,
  PrismaBillingRepository,
} from '../database/index.js';
import { createMetrics } from '../metrics/index.js';
import { buildServer } from './server.js';

// Spec 032, E7: a pessoa exclui a própria conta pelo site (cookie e senha), com Postgres (soprei_test) e
// Redis (/15) reais. O núcleo é o mesmo da remoção pelo admin (spec 045, E6), que tem as recusas completas
// em `platform-account-anonymize.integration.test.ts`; aqui, o caminho do site.

const config = loadIntegrationConfig();
const keyspace = new TestKeyspace();
const SITE = 'http://localhost:5174';
const SITE_HEADERS = { origin: SITE, 'x-soprei-app': 'web' } as const;
const BILLING = { graceDays: 5, trialDays: 7, trialTokens: 600_000, trialReplies: 100 };
const DAY = 86_400_000;

const tag = randomBytes(4).toString('hex');
const EMAIL_X = `e7-x-${tag}@exemplo.test`;
const EMAIL_Y = `e7-y-${tag}@exemplo.test`;
const PASSWORD = `Senha1-${randomUUID()}`;
const WRONG = `Errada1-${randomUUID()}`;

let database: Database;
let tenants: TestTenants;
let authRedis: AuthRedisHandle;
let auth: AuthComponents;
let app: FastifyInstance;
let accountService: AccountService;
let anonymizer: AccountAnonymizer;
const logs = captureLogs();
const createdAccounts: string[] = [];
const verificationMail = new Map<string, string>();
const deletedMail: string[] = [];
const fault = { revokeAll: false };
const bodies: string[] = [];
const metrics = createMetrics();

const db = () => database.prisma;

async function site(
  url: string,
  payload: object,
  cookie?: string,
): Promise<LightMyRequestResponse> {
  const response = await app.inject({
    method: 'POST',
    url,
    headers: { ...SITE_HEADERS, ...(cookie === undefined ? {} : { cookie }) },
    payload,
  });
  bodies.push(response.body);
  return response;
}

const remove = (cookie: string, password = PASSWORD) =>
  site('/account/delete', { password }, cookie);

async function register(address: string): Promise<AccountId> {
  assert.equal(
    (await site('/auth/register', { email: address, password: PASSWORD })).statusCode,
    202,
  );
  await accountService.drain();
  const row = await db().account.findUnique({ where: { email: address }, select: { id: true } });
  assert.ok(row);
  createdAccounts.push(row.id);
  return AccountId.parse(row.id);
}

async function confirmedAccount(address: string): Promise<{ id: AccountId; cookie: string }> {
  const id = await register(address);
  const verified = await site('/auth/verify-email', {
    email: address,
    password: PASSWORD,
    code: verificationMail.get(address),
  });
  assert.equal(verified.statusCode, 204);
  const login = await site('/auth/login', { email: address, password: PASSWORD });
  assert.equal(login.statusCode, 204, login.body);
  return { id, cookie: String(login.headers['set-cookie']).split(';')[0] ?? '' };
}

async function membership(
  company: Company,
  account: AccountId,
  role: 'OWNER' | 'AGENT',
  address: string,
): Promise<string> {
  const row = await db().membership.create({
    data: { companyId: company.id, email: address, passwordHash: 'x', role, accountId: account },
  });
  return row.id;
}

async function account(id: AccountId) {
  const row = await db().account.findFirst({
    where: { id },
    select: { email: true, status: true, lastCompanyId: true },
  });
  assert.ok(row);
  return row;
}

const session = (cookie: string) =>
  app.inject({ url: '/auth/session', headers: { cookie } }).then((r) => r.statusCode);

before(async () => {
  database = createDatabase(config, logs.logger);
  tenants = new TestTenants(database.prisma);
  authRedis = createAuthRedis(config, logs.logger);
  assert.ok(await authRedis.waitUntilReady(5_000));
  const prefix = keyspace.scopedPrefix('account-delete-e7');
  const passwords = new ScryptPasswordHasher({ cost: { N: 1024, r: 8, p: 1 } });
  auth = createAuthComponents({
    config: { ...config, ACCOUNTS_ENABLED: true, AUTH_REDIS_PREFIX: prefix },
    logger: logs.logger,
    prisma: database.prisma,
    authRedis,
    hasher: passwords,
  });
  const store = new RedisAccountSessionStore(authRedis.client, prefix);
  const accountSessions: AccountSessionStore = {
    create: (id) => store.create(id),
    read: (secret) => store.read(secret),
    select: (secret, companyId) => store.select(secret, companyId),
    revoke: (secret) => store.revoke(secret),
    revokeAll: (id) =>
      fault.revokeAll
        ? Promise.reject(new ServiceUnavailableError('Sessão indisponível'))
        : store.revokeAll(id),
  };
  anonymizer = new AccountAnonymizer({
    accounts: new PrismaAccountAnonymizationUnitOfWork(database.prisma),
    accountSessions,
    bearerSessions: auth.sessions,
    mailer: {
      sendAccountDeleted: (address) => {
        deletedMail.push(address);
        return Promise.resolve();
      },
    },
    logger: logs.logger,
  });
  let counter = 700_000;
  accountService = new AccountService({
    accounts: new PrismaAccountRepository(database.prisma),
    passwords,
    sessions: accountSessions,
    loginLocks: auth.sessions,
    loginSecret: config.JWT_SECRET,
    randomInt: () => counter++,
    anonymizer,
    onAccountDeleted: () => {
      metrics.countAccountDeleted();
    },
    mailer: {
      sendVerification: (address, code) => {
        verificationMail.set(address, code);
        return Promise.resolve();
      },
      sendPasswordReset: () => Promise.resolve(),
      sendPasswordChanged: () => Promise.resolve(),
    },
  });
  app = buildServer({
    logger: logs.logger,
    readiness: {
      database: () => database.check(),
      redis: () => Promise.resolve(Result.ok(undefined)),
    },
    metrics,
    auth: auth.service,
    accounts: { service: accountService, origin: SITE, secure: false },
  });
  await app.ready();
});

after(async () => {
  try {
    await app.close();
    await accountService.drain();
    await anonymizer.drain();
    await tenants.cleanup();
    await db().subscription.deleteMany({ where: { accountId: { in: createdAccounts } } });
    await db().account.deleteMany({ where: { id: { in: createdAccounts } } });
    await keyspace.cleanup(authRedis.client);
  } finally {
    await authRedis.close();
    await database.close();
  }
});

describe('excluir a própria conta pelo site com Postgres e Redis reais (spec 032, E7)', () => {
  let x: { id: AccountId; cookie: string };
  let y: { id: AccountId; cookie: string };
  let companyA: Company;
  let companyB: Company;
  let membershipXB = '';
  let membershipY = '';

  it('senha errada = 401 uniforme; única dona = 409 COMPANY_OWNERSHIP; período pago = 409 SUBSCRIPTION_ACTIVE; nada muda', async () => {
    x = await confirmedAccount(EMAIL_X);
    y = await confirmedAccount(EMAIL_Y);
    // A: X é a única dona. B: Y é dona e X atendente.
    companyA = await tenants.createCompany('e7-a');
    companyB = await tenants.createCompany('e7-b');
    await membership(companyA, x.id, 'OWNER', `xa-${tag}@exemplo.test`);
    membershipXB = await membership(companyB, x.id, 'AGENT', `xb-${tag}@exemplo.test`);
    membershipY = await membership(companyB, y.id, 'OWNER', `yb-${tag}@exemplo.test`);
    // Um evento de auditoria de B aponta para o vínculo de X (deve continuar apontando).
    await db().auditEvent.create({
      data: {
        companyId: companyB.id,
        action: 'MEMBERSHIP_CREATED',
        actorMembershipId: membershipY,
        targetMembershipId: membershipXB,
        toRole: 'AGENT',
      },
    });

    const wrong = await remove(x.cookie, WRONG);
    assert.equal(wrong.statusCode, 401);
    const login = await site('/auth/login', { email: EMAIL_X, password: WRONG });
    assert.equal(wrong.json<{ error: unknown }>().error, login.json<{ error: unknown }>().error);
    // O sucesso do login zera o bloqueio por conta (a mesma chave da exclusão).
    assert.equal(
      (await site('/auth/login', { email: EMAIL_X, password: PASSWORD })).statusCode,
      204,
    );

    const owner = await remove(x.cookie);
    assert.equal(owner.statusCode, 409, owner.body);
    assert.equal(owner.json<{ error: { code: string } }>().error.code, 'COMPANY_OWNERSHIP');
    assert.equal(owner.headers['set-cookie'], undefined);

    // A removida não barra; a assinatura paga em vigor sem cancelamento barra.
    await db().company.updateMany({ where: { id: companyA.id }, data: { deletedAt: new Date() } });
    const now = new Date();
    await new PrismaBillingRepository(db()).ensureTrial(x.id, now, BILLING);
    await db().subscription.updateMany({
      where: { accountId: x.id },
      data: {
        status: 'ACTIVE',
        currentPeriodStart: new Date(now.getTime() - DAY),
        currentPeriodEnd: new Date(now.getTime() + 20 * DAY),
        trialEndsAt: null,
      },
    });
    const paid = await remove(x.cookie);
    assert.equal(paid.statusCode, 409, paid.body);
    assert.equal(paid.json<{ error: { code: string } }>().error.code, 'SUBSCRIPTION_ACTIVE');

    assert.equal((await account(x.id)).email, EMAIL_X);
    assert.equal((await account(x.id)).status, 'ACTIVE');
    assert.equal(await session(x.cookie), 200);
    assert.deepEqual(deletedMail, []);
  });

  it('Redis das sessões fora antes de alterar: 503 e nada anonimizado', async () => {
    await db().subscription.updateMany({
      where: { accountId: x.id },
      data: { cancelAtPeriodEnd: true },
    });
    fault.revokeAll = true;
    try {
      const response = await remove(x.cookie);
      assert.equal(response.statusCode, 503, response.body);
      assert.equal(response.headers['set-cookie'], undefined);
    } finally {
      fault.revokeAll = false;
    }
    assert.equal((await account(x.id)).email, EMAIL_X);
    assert.equal((await account(x.id)).status, 'ACTIVE');
    assert.deepEqual(deletedMail, []);
  });

  it('sucesso: conta e vínculos anonimizados, cookie limpo, sessões fora, aviso ao endereço antigo; a auditoria continua apontando para o vínculo; o vínculo de outra conta não muda', async () => {
    // O 503 anterior já derrubou as sessões de X: entra de novo.
    const login = await site('/auth/login', { email: EMAIL_X, password: PASSWORD });
    assert.equal(login.statusCode, 204);
    x = { ...x, cookie: String(login.headers['set-cookie']).split(';')[0] ?? '' };

    const response = await remove(x.cookie);
    assert.equal(response.statusCode, 204, response.body);
    assert.match(String(response.headers['set-cookie']), /^soprei_session=; .*Max-Age=0/);
    await anonymizer.drain();

    const row = await account(x.id);
    assert.ok(isAnonymizedEmail(row.email));
    assert.equal(row.status, 'DISABLED');
    assert.equal(row.lastCompanyId, null);
    // Uma empresa por vez: a tenant-scope exige `companyId` exato no `where`.
    const memberships = (
      await Promise.all(
        [companyA.id, companyB.id].map((companyId) =>
          db().membership.findMany({
            where: { companyId, accountId: x.id },
            select: { email: true, status: true },
          }),
        ),
      )
    ).flat();
    assert.equal(memberships.length, 2);
    assert.ok(memberships.every((m) => m.email === row.email && m.status === 'DISABLED'));
    const other = await db().membership.findFirst({
      where: { companyId: companyB.id, id: membershipY },
      select: { email: true, status: true },
    });
    assert.deepEqual(other, { email: `yb-${tag}@exemplo.test`, status: 'ACTIVE' });
    const audit = await db().auditEvent.findFirst({
      where: { companyId: companyB.id, targetMembershipId: membershipXB },
      select: { id: true },
    });
    assert.ok(audit, 'a auditoria continua apontando para o vínculo anonimizado');

    assert.deepEqual(deletedMail, [EMAIL_X]);
    assert.equal(await session(x.cookie), 401);
    assert.equal(await session(y.cookie), 200);
    assert.equal(
      (await site('/auth/login', { email: EMAIL_X, password: PASSWORD })).statusCode,
      401,
    );
    // O mesmo cookie não exclui de novo.
    assert.equal((await remove(x.cookie)).statusCode, 401);
    assert.ok((await metrics.render()).includes('account_deleted_total 1'));
  });

  it('o e-mail antigo fica livre para um cadastro novo, que não herda nada', async () => {
    const fresh = await register(EMAIL_X);
    assert.notEqual(fresh, x.id);
    assert.equal(
      await db().membership.count({ where: { companyId: companyB.id, accountId: fresh } }),
      0,
    );
    assert.equal(await db().subscription.count({ where: { accountId: fresh } }), 0);
  });

  it('privacidade: nenhum e-mail, senha ou cookie em resposta ou log', () => {
    const raw = logs.raw();
    for (const secret of [
      EMAIL_X,
      EMAIL_Y,
      `xa-${tag}@exemplo.test`,
      `xb-${tag}@exemplo.test`,
      PASSWORD,
      WRONG,
      x.cookie.split('=')[1] ?? '',
    ]) {
      assert.ok(!bodies.some((body) => body.includes(secret)), `resposta: ${secret}`);
      assert.ok(!logContains(raw, secret), `log: ${secret}`);
    }
  });
});
