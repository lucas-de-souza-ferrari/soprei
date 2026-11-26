import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { AccountAnonymizer, isAnonymizedEmail } from '../../application/auth/account-anonymizer.js';
import { AccountService } from '../../application/auth/account.service.js';
import type { AccountSessionStore } from '../../application/ports/account-session.js';
import { PlatformAccountService } from '../../application/platform/platform-account.service.js';
import { PlatformAuthService } from '../../application/platform/platform-auth.service.js';
import { factorFingerprint } from '../../application/platform/totp-second-factor.js';
import { AccountId, type Company, type PlatformAdminId } from '../../domain/index.js';
import { ServiceUnavailableError } from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { captureLogs, logContains } from '../../test-support/log-capture.js';
import { TestKeyspace } from '../../test-support/test-keyspace.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import { PLATFORM_COOKIE } from '../../presentation/platform/platform-auth.controller.js';
import { type AuthRedisHandle, createAuthRedis } from '../auth/auth-redis.js';
import { type AuthComponents, createAuthComponents } from '../auth/create-auth.js';
import { RedisAccountSessionStore } from '../auth/redis-account-session-store.js';
import { RedisPlatformSessionStore } from '../auth/redis-platform-session-store.js';
import { ScryptPasswordHasher } from '../auth/scrypt-password-hasher.js';
import {
  createDatabase,
  type Database,
  PrismaAccountAnonymizationUnitOfWork,
  PrismaAccountRepository,
  PrismaBillingRepository,
  PrismaPlatformAccountUnitOfWork,
  PrismaPlatformAdminRepository,
  PrismaPlatformAuditRepository,
} from '../database/index.js';
import { createMetrics } from '../metrics/index.js';
import { buildServer } from './server.js';

// Spec 045, E6: remover uma conta por anonimização pelo admin da plataforma, com Postgres (soprei_test) e
// Redis (/15) reais. A conferência do código do autenticador tem teste próprio com o TOTP de verdade
// (`platform-account.controller.test.ts`); aqui ela é um dublê que aceita.

const config = loadIntegrationConfig();
const keyspace = new TestKeyspace();
const ORIGIN = 'https://soadm.exemplo.test';
const SITE = 'http://localhost:5174';
const WRITE = { origin: ORIGIN, 'x-soprei-app': 'admin' } as const;
const SITE_HEADERS = { origin: SITE, 'x-soprei-app': 'web' } as const;
const CODE = '123456';
const BILLING = { graceDays: 5, trialDays: 7, trialTokens: 600_000, trialReplies: 100 };
const DAY = 86_400_000;

const tag = randomBytes(4).toString('hex');
const EMAIL_X = `plat-e6-x-${tag}@exemplo.test`;
const EMAIL_Y = `plat-e6-y-${tag}@exemplo.test`;
const PASSWORD = `Senha1-${randomUUID()}`;

let database: Database;
let tenants: TestTenants;
let authRedis: AuthRedisHandle;
let auth: AuthComponents;
let app: FastifyInstance;
let accountService: AccountService;
let anonymizer: AccountAnonymizer;
const logs = captureLogs();
let cookie: string;
let adminId: PlatformAdminId;
const createdAdmins: string[] = [];
const createdAccounts: string[] = [];
const verificationMail = new Map<string, string>();
const deletedMail: string[] = [];
const bearerCalls: string[] = [];
const fault = { revokeAll: false };
const bodies: string[] = [];

const db = () => database.prisma;

async function post(url: string, payload: object): Promise<LightMyRequestResponse> {
  const response = await app.inject({
    method: 'POST',
    url,
    headers: { ...WRITE, cookie },
    payload,
  });
  bodies.push(response.body);
  return response;
}

const anonymize = (id: string) =>
  post(`/platform/accounts/${id}/anonymize`, {
    reason: 'OWNER_REQUEST',
    code: CODE,
    confirm: 'EXCLUIR',
  });

const site = (url: string, payload: object) =>
  app.inject({ method: 'POST', url, headers: SITE_HEADERS, payload });

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
    select: { email: true, status: true, passwordHash: true, lastCompanyId: true },
  });
  assert.ok(row);
  return row;
}

async function actions(subject: AccountId): Promise<string[]> {
  const rows = await db().platformAuditEvent.findMany({
    where: { adminId, subjectAccountId: subject },
    orderBy: { createdAt: 'asc' },
    select: { action: true },
  });
  return rows.map((row) => row.action);
}

before(async () => {
  database = createDatabase(config, logs.logger);
  tenants = new TestTenants(database.prisma);
  authRedis = createAuthRedis(config, logs.logger);
  assert.ok(await authRedis.waitUntilReady(5_000));
  const prefix = keyspace.scopedPrefix('platform-accounts-e6');
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
  let counter = 600_000;
  accountService = new AccountService({
    accounts: new PrismaAccountRepository(database.prisma),
    passwords,
    sessions: accountSessions,
    loginLocks: auth.sessions,
    loginSecret: config.JWT_SECRET,
    randomInt: () => counter++,
    mailer: {
      sendVerification: (address, code) => {
        verificationMail.set(address, code);
        return Promise.resolve();
      },
      sendPasswordReset: () => Promise.resolve(),
      sendPasswordChanged: () => Promise.resolve(),
    },
  });
  const bearerSessions = {
    revokeAllSessions: (
      scope: Parameters<typeof auth.sessions.revokeAllSessions>[0],
      subject: string,
    ) => {
      bearerCalls.push(subject);
      return auth.sessions.revokeAllSessions(scope, subject);
    },
  };
  anonymizer = new AccountAnonymizer({
    accounts: new PrismaAccountAnonymizationUnitOfWork(database.prisma),
    accountSessions,
    bearerSessions,
    mailer: {
      sendAccountDeleted: (address) => {
        deletedMail.push(address);
        return Promise.resolve();
      },
    },
    logger: logs.logger,
  });

  const admins = new PrismaPlatformAdminRepository(database.prisma);
  const admin = await admins.create({ email: `adm-e6-${tag}@exemplo.test`, passwordHash: 'x' });
  adminId = admin.id;
  createdAdmins.push(admin.id);
  const ciphertext = `v1.t1.${randomBytes(12).toString('base64url')}.tag.corpo`;
  await admins.setTotpSecret(admin.id, ciphertext);
  const platformSessions = new RedisPlatformSessionStore(authRedis.client, prefix, 1_800, 43_200);
  cookie = `${PLATFORM_COOKIE}=${await platformSessions.create(admin.id, factorFingerprint(ciphertext))}`;

  const metrics = createMetrics();
  app = buildServer({
    logger: logs.logger,
    readiness: {
      database: () => database.check(),
      redis: () => Promise.resolve(Result.ok(undefined)),
    },
    metrics,
    auth: auth.service,
    accounts: { service: accountService, origin: SITE, secure: false },
    platform: {
      auth: new PlatformAuthService({
        credentials: {
          verifyPlatformCredentials: () => Promise.reject(new Error('sem login aqui')),
        },
        admins,
        sessions: platformSessions,
        audit: new PrismaPlatformAuditRepository(database.prisma),
        logger: logs.logger,
        metrics,
      }),
      origin: ORIGIN,
      maxAgeSeconds: 43_200,
      accounts: new PlatformAccountService({
        accounts: new PrismaPlatformAccountUnitOfWork(database.prisma),
        confirmer: {
          confirmPlatformCode: (_id, code) =>
            Promise.resolve(
              code === CODE ? Result.ok(undefined) : Result.err({ reason: 'invalid_credentials' }),
            ),
        },
        accountSessions,
        bearerSessions,
        mail: accountService,
        anonymizer,
        logger: logs.logger,
        metrics,
      }),
    },
  });
  await app.ready();
});

after(async () => {
  try {
    await app.close();
    await accountService.drain();
    await anonymizer.drain();
    await db().platformAuditEvent.deleteMany({ where: { adminId: { in: createdAdmins } } });
    await tenants.cleanup();
    await db().subscription.deleteMany({ where: { accountId: { in: createdAccounts } } });
    await db().account.deleteMany({ where: { id: { in: createdAccounts } } });
    await db().platformAdmin.deleteMany({ where: { id: { in: createdAdmins } } });
    await keyspace.cleanup(authRedis.client);
  } finally {
    await authRedis.close();
    await database.close();
  }
});

describe('remover uma conta por anonimização com Postgres e Redis reais (spec 045, E6)', () => {
  let x: { id: AccountId; cookie: string };
  let y: { id: AccountId; cookie: string };
  let companyA: Company;
  let companyB: Company;
  const membershipsX: string[] = [];
  let membershipY = '';

  it('recusas sem efeito: única dona ativa (também de empresa suspensa) = 409 COMPANY_OWNERSHIP; período pago em vigor sem cancelamento = 409 SUBSCRIPTION_ACTIVE', async () => {
    x = await confirmedAccount(EMAIL_X);
    y = await confirmedAccount(EMAIL_Y);
    // A: X é a única dona. B: Y é dona e X atendente (o vínculo de Y nunca é tocado).
    companyA = await tenants.createCompany('pe6-a');
    companyB = await tenants.createCompany('pe6-b');
    membershipsX.push(await membership(companyA, x.id, 'OWNER', `xa-${tag}@exemplo.test`));
    membershipsX.push(await membership(companyB, x.id, 'AGENT', `xb-${tag}@exemplo.test`));
    membershipY = await membership(companyB, y.id, 'OWNER', `yb-${tag}@exemplo.test`);

    const blocked = await anonymize(x.id);
    assert.equal(blocked.statusCode, 409, blocked.body);
    assert.equal(blocked.json<{ error: { code: string } }>().error.code, 'COMPANY_OWNERSHIP');

    await db().company.updateMany({ where: { id: companyA.id }, data: { status: 'SUSPENDED' } });
    const suspended = await anonymize(x.id);
    assert.equal(suspended.statusCode, 409);
    assert.equal(suspended.json<{ error: { code: string } }>().error.code, 'COMPANY_OWNERSHIP');

    // A removida não barra; agora a assinatura paga em vigor barra.
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
    const paid = await anonymize(x.id);
    assert.equal(paid.statusCode, 409, paid.body);
    assert.equal(paid.json<{ error: { code: string } }>().error.code, 'SUBSCRIPTION_ACTIVE');

    assert.equal((await account(x.id)).email, EMAIL_X);
    assert.equal((await account(x.id)).status, 'ACTIVE');
    assert.deepEqual(await actions(x.id), []);
    assert.equal(
      (await app.inject({ url: '/auth/session', headers: { cookie: x.cookie } })).statusCode,
      200,
    );
  });

  it('Redis fora antes de alterar: 503 e nada muda', async () => {
    // Cancelamento marcado: a assinatura não barra mais.
    await db().subscription.updateMany({
      where: { accountId: x.id },
      data: { cancelAtPeriodEnd: true },
    });
    fault.revokeAll = true;
    try {
      const response = await anonymize(x.id);
      assert.equal(response.statusCode, 503, response.body);
    } finally {
      fault.revokeAll = false;
    }
    assert.equal((await account(x.id)).email, EMAIL_X);
    assert.deepEqual(await actions(x.id), []);
    assert.deepEqual(deletedMail, []);
  });

  it('sucesso: conta e vínculos anonimizados, sessões fora, trilha, aviso ao endereço antigo; assinatura e a trilha continuam ligadas; o vínculo de outra conta não muda', async () => {
    const subscriptionBefore = await db().subscription.findFirst({
      where: { accountId: x.id },
      select: { id: true },
    });
    assert.ok(subscriptionBefore);

    const response = await anonymize(x.id);
    assert.equal(response.statusCode, 204, response.body);
    await anonymizer.drain();

    const row = await account(x.id);
    assert.ok(isAnonymizedEmail(row.email));
    assert.equal(row.status, 'DISABLED');
    assert.equal(row.lastCompanyId, null);
    assert.notEqual(row.passwordHash.length, 0);
    const memberships = await db().membership.findMany({
      where: { companyId: { in: [companyA.id, companyB.id] }, accountId: x.id },
      select: { id: true, email: true, status: true },
    });
    assert.equal(memberships.length, 2);
    assert.ok(memberships.every((m) => m.email === row.email && m.status === 'DISABLED'));
    const other = await db().membership.findFirst({
      where: { companyId: companyB.id, id: membershipY },
      select: { email: true, status: true },
    });
    assert.deepEqual(other, { email: `yb-${tag}@exemplo.test`, status: 'ACTIVE' });

    assert.deepEqual(await actions(x.id), ['ACCOUNT_ANONYMIZED']);
    assert.deepEqual(deletedMail, [EMAIL_X]);
    assert.deepEqual([...bearerCalls].sort(), [...membershipsX].sort());
    assert.equal(
      (await app.inject({ url: '/auth/session', headers: { cookie: x.cookie } })).statusCode,
      401,
    );
    assert.equal(
      (await site('/auth/login', { email: EMAIL_X, password: PASSWORD })).statusCode,
      401,
    );
    const subscriptionAfter = await db().subscription.findFirst({
      where: { accountId: x.id },
      select: { id: true },
    });
    assert.equal(subscriptionAfter?.id, subscriptionBefore.id);
    assert.equal(
      (await app.inject({ url: '/auth/session', headers: { cookie: y.cookie } })).statusCode,
      200,
    );
  });

  it('repetir: 204 sem novo evento nem e-mail; o endereço antigo fica livre para um cadastro novo, que não herda nada', async () => {
    const again = await anonymize(x.id);
    assert.equal(again.statusCode, 204);
    await anonymizer.drain();
    assert.deepEqual(await actions(x.id), ['ACCOUNT_ANONYMIZED']);
    assert.deepEqual(deletedMail, [EMAIL_X]);

    // Reativar uma conta removida: 409 ACCOUNT_ANONYMIZED, ela continua desativada.
    const enable = await post(`/platform/accounts/${x.id}/enable`, { reason: 'OTHER' });
    assert.equal(enable.statusCode, 409, enable.body);
    assert.equal(enable.json<{ error: { code: string } }>().error.code, 'ACCOUNT_ANONYMIZED');
    assert.equal((await account(x.id)).status, 'DISABLED');

    const fresh = await register(EMAIL_X);
    assert.notEqual(fresh, x.id);
    assert.equal(
      await db().membership.count({ where: { companyId: companyB.id, accountId: fresh } }),
      0,
    );
    assert.equal(await db().subscription.count({ where: { accountId: fresh } }), 0);
  });

  it('privacidade: nenhum e-mail em resposta ou log; a trilha só tem ids e enums', () => {
    const raw = logs.raw();
    for (const address of [EMAIL_X, EMAIL_Y]) {
      assert.ok(!bodies.some((body) => body.includes(address)), `resposta: ${address}`);
      assert.ok(!logContains(raw, address), `log: ${address}`);
    }
  });
});
