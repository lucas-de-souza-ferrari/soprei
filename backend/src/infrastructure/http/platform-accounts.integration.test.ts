import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { AccountService } from '../../application/auth/account.service.js';
import type { AccountSessionStore } from '../../application/ports/account-session.js';
import type { PlatformAccountUnitOfWork } from '../../application/ports/platform-account-unit-of-work.js';
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
  PrismaAccountRepository,
  PrismaPlatformAccountUnitOfWork,
  PrismaPlatformAdminRepository,
  PrismaPlatformAuditRepository,
} from '../database/index.js';
import { createMetrics } from '../metrics/index.js';
import { buildServer } from './server.js';

// Spec 045, E2: as ações do admin da plataforma sobre contas com Postgres (soprei_test) e Redis (/15)
// reais. A conferência do código do autenticador (regra comum 3) tem teste próprio com o TOTP de verdade
// (`platform-action-confirmation.test.ts` e `platform-account.controller.test.ts`); aqui ela é um dublê que
// aceita, para que o teste se concentre no banco, nas sessões e nos e-mails.

const config = loadIntegrationConfig();
const keyspace = new TestKeyspace();
const ORIGIN = 'https://soadm.exemplo.test';
const SITE = 'http://localhost:5174';
const WRITE = { origin: ORIGIN, 'x-soprei-app': 'admin' } as const;
const SITE_HEADERS = { origin: SITE, 'x-soprei-app': 'web' } as const;
const CODE = '123456';

const tag = randomBytes(4).toString('hex');
const email = (label: string): string => `plat-e2-${label}-${tag}@exemplo.test`;
const EMAIL_X = email('x');
const EMAIL_Y = email('y');
const EMAIL_Z = email('z');
const EMAIL_W = email('w');
const PASSWORD = `Senha1-${randomUUID()}`;
const NEW_PASSWORD = `Nova1-${randomUUID()}`;

let database: Database;
let tenants: TestTenants;
let authRedis: AuthRedisHandle;
let auth: AuthComponents;
let app: FastifyInstance;
let accountService: AccountService;
let platformAccounts: PlatformAccountService;
const logs = captureLogs();
let cookie: string;
let adminId: PlatformAdminId;
let clock = Date.now();
const createdAdmins: string[] = [];
const verificationMail = new Map<string, string>();
const resetMail = new Map<string, string>();
const resetSends: string[] = [];
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

const site = (url: string, payload: object) =>
  app.inject({ method: 'POST', url, headers: SITE_HEADERS, payload });

async function confirmedAccount(address: string): Promise<{ id: AccountId; cookie: string }> {
  assert.equal(
    (await site('/auth/register', { email: address, password: PASSWORD })).statusCode,
    202,
  );
  await accountService.drain();
  const verified = await site('/auth/verify-email', {
    email: address,
    password: PASSWORD,
    code: verificationMail.get(address),
  });
  assert.equal(verified.statusCode, 204);
  return { id: await accountId(address), cookie: await login(address, PASSWORD) };
}

async function login(address: string, password: string): Promise<string> {
  const response = await site('/auth/login', { email: address, password });
  assert.equal(response.statusCode, 204, response.body);
  return String(response.headers['set-cookie']).split(';')[0] ?? '';
}

async function accountId(address: string): Promise<AccountId> {
  const row = await db().account.findUnique({ where: { email: address }, select: { id: true } });
  assert.ok(row);
  return AccountId.parse(row.id);
}

async function sessionStatus(siteCookie: string): Promise<number> {
  return (await app.inject({ url: '/auth/session', headers: { cookie: siteCookie } })).statusCode;
}

async function owner(company: Company, account: AccountId, label: string): Promise<string> {
  const row = await db().membership.create({
    data: {
      companyId: company.id,
      email: `${label}-${tag}@exemplo.test`,
      passwordHash: 'x',
      role: 'OWNER',
      accountId: account,
    },
  });
  return row.id;
}

async function events(subject: AccountId): Promise<{ action: string; reason: string | null }[]> {
  return db().platformAuditEvent.findMany({
    where: { adminId, subjectAccountId: subject },
    orderBy: { createdAt: 'asc' },
    select: { action: true, reason: true },
  });
}

async function status(account: AccountId): Promise<string | undefined> {
  return (await db().account.findFirst({ where: { id: account }, select: { status: true } }))
    ?.status;
}

before(async () => {
  database = createDatabase(config, logs.logger);
  tenants = new TestTenants(database.prisma);
  authRedis = createAuthRedis(config, logs.logger);
  assert.ok(await authRedis.waitUntilReady(5_000));
  const prefix = keyspace.scopedPrefix('platform-accounts-e2');
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
  let counter = 500_000;
  accountService = new AccountService({
    accounts: new PrismaAccountRepository(database.prisma),
    passwords,
    sessions: accountSessions,
    loginLocks: auth.sessions,
    loginSecret: config.JWT_SECRET,
    now: () => new Date(clock),
    randomInt: () => counter++,
    mailer: {
      sendVerification: (address, code) => {
        verificationMail.set(address, code);
        return Promise.resolve();
      },
      sendPasswordReset: (address, code) => {
        resetSends.push(address);
        resetMail.set(address, code);
        return Promise.resolve();
      },
      sendPasswordChanged: () => Promise.resolve(),
    },
  });

  const admins = new PrismaPlatformAdminRepository(database.prisma);
  const admin = await admins.create({ email: `adm-${tag}@exemplo.test`, passwordHash: 'x' });
  adminId = admin.id;
  createdAdmins.push(admin.id);
  const ciphertext = `v1.t1.${randomBytes(12).toString('base64url')}.tag.corpo`;
  await admins.setTotpSecret(admin.id, ciphertext);
  const platformSessions = new RedisPlatformSessionStore(authRedis.client, prefix, 1_800, 43_200);
  cookie = `${PLATFORM_COOKIE}=${await platformSessions.create(admin.id, factorFingerprint(ciphertext))}`;

  const metrics = createMetrics();
  const audit = new PrismaPlatformAuditRepository(database.prisma);
  platformAccounts = new PlatformAccountService({
    accounts: new PrismaPlatformAccountUnitOfWork(database.prisma),
    confirmer: {
      confirmPlatformCode: (id, code) => {
        assert.equal(id, adminId);
        return Promise.resolve(
          code === CODE ? Result.ok(undefined) : Result.err({ reason: 'invalid_credentials' }),
        );
      },
    },
    accountSessions,
    bearerSessions: {
      revokeAllSessions: (scope, subject) => {
        bearerCalls.push(`${scope}:${subject}`);
        return auth.sessions.revokeAllSessions(scope, subject);
      },
    },
    mail: accountService,
    logger: logs.logger,
    metrics,
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
    platform: {
      auth: new PlatformAuthService({
        credentials: {
          verifyPlatformCredentials: () => Promise.reject(new Error('sem login aqui')),
        },
        admins,
        sessions: platformSessions,
        audit,
        logger: logs.logger,
        metrics,
      }),
      origin: ORIGIN,
      maxAgeSeconds: 43_200,
      accounts: platformAccounts,
    },
  });
  await app.ready();
});

after(async () => {
  try {
    await app.close();
    await accountService.drain();
    await db().platformAuditEvent.deleteMany({ where: { adminId: { in: createdAdmins } } });
    await tenants.cleanup();
    await db().account.deleteMany({
      where: { email: { in: [EMAIL_X, EMAIL_Y, EMAIL_Z, EMAIL_W] } },
    });
    await db().platformAdmin.deleteMany({ where: { id: { in: createdAdmins } } });
    await keyspace.cleanup(authRedis.client);
  } finally {
    await authRedis.close();
    await database.close();
  }
});

describe('ações do admin da plataforma sobre contas com Postgres e Redis reais (spec 045, E2)', () => {
  let x: { id: AccountId; cookie: string };
  let y: { id: AccountId; cookie: string };
  let z: { id: AccountId; cookie: string };
  let companyA: Company;
  let companyC: Company;
  const membershipsX: string[] = [];
  let membershipY = '';

  it('desativar: única dona ativa de empresa ativa = 409 LAST_OWNER (também quando o outro OWNER tem a conta desativada); suspensa, removida ou com outro dono ativo não barra', async () => {
    x = await confirmedAccount(EMAIL_X);
    y = await confirmedAccount(EMAIL_Y);
    z = await confirmedAccount(EMAIL_Z);
    // A: X é a única dona (ativa). B: removida, X única dona. C: X e Z donos, Z com a conta desativada.
    // D: X e Y donas (Y ativa). Y também tem um vínculo em A (atendente), que não pode ser tocado.
    companyA = await tenants.createCompany('pe2-a');
    const companyB = await tenants.createCompany('pe2-b');
    companyC = await tenants.createCompany('pe2-c');
    const companyD = await tenants.createCompany('pe2-d');
    membershipsX.push(await owner(companyA, x.id, 'xa'));
    membershipsX.push(await owner(companyB, x.id, 'xb'));
    membershipsX.push(await owner(companyC, x.id, 'xc'));
    membershipsX.push(await owner(companyD, x.id, 'xd'));
    await owner(companyC, z.id, 'zc');
    await owner(companyD, y.id, 'yd');
    membershipY = (
      await db().membership.create({
        data: {
          companyId: companyA.id,
          email: `ya-${tag}@exemplo.test`,
          passwordHash: 'x',
          role: 'AGENT',
          accountId: y.id,
        },
      })
    ).id;
    await db().company.updateMany({
      where: { id: companyB.id },
      data: { deletedAt: new Date() },
    });
    await db().account.updateMany({ where: { id: z.id }, data: { status: 'DISABLED' } });

    const url = `/platform/accounts/${x.id}/disable`;
    const blocked = await post(url, { reason: 'ABUSE', code: CODE });
    assert.equal(blocked.statusCode, 409, blocked.body);
    assert.equal(blocked.json<{ error: { code: string } }>().error.code, 'LAST_OWNER');
    assert.equal(await status(x.id), 'ACTIVE');
    assert.deepEqual(await events(x.id), []);

    // A suspensa: C ainda barra (Z é OWNER ativo, mas com a conta desativada não é "dono ativo").
    await db().company.updateMany({ where: { id: companyA.id }, data: { status: 'SUSPENDED' } });
    const stillBlocked = await post(url, { reason: 'ABUSE', code: CODE });
    assert.equal(stillBlocked.statusCode, 409);
    assert.equal(await status(x.id), 'ACTIVE');

    // Z reativada: C tem outro dono ativo; B removida e A suspensa não contam.
    await db().account.updateMany({ where: { id: z.id }, data: { status: 'ACTIVE' } });
    assert.equal(bearerCalls.length, 0);
    const ok = await post(url, { reason: 'ABUSE', code: CODE });
    assert.equal(ok.statusCode, 204, ok.body);
    assert.equal(await status(x.id), 'DISABLED');
    assert.deepEqual(await events(x.id), [{ action: 'ACCOUNT_DISABLED', reason: 'ABUSE' }]);
  });

  it('depois do commit: o cookie da conta recebe 401 e as sessões Bearer de cada vínculo dela são revogadas; a outra conta e os vínculos ficam intactos', async () => {
    assert.equal(await sessionStatus(x.cookie), 401);
    assert.equal(await sessionStatus(y.cookie), 200);
    const revoked = bearerCalls.map((call) => call.split(':')[1]);
    assert.deepEqual([...revoked].sort(), [...membershipsX].sort());
    assert.ok(!revoked.includes(membershipY), 'o vínculo da outra conta não é tocado');
    const y2 = await db().membership.findFirst({
      where: { companyId: companyA.id, id: membershipY },
      select: { status: true },
    });
    assert.equal(y2?.status, 'ACTIVE');
    // Desativar a conta não mexe nos vínculos dela.
    const own = await db().membership.findFirst({
      where: { companyId: companyC.id, accountId: x.id },
      select: { status: true },
    });
    assert.equal(own?.status, 'ACTIVE');
    // Login com a conta desativada não entra.
    const denied = await site('/auth/login', { email: EMAIL_X, password: PASSWORD });
    assert.equal(denied.statusCode, 401);
  });

  it('repetir no mesmo estado: 204 sem evento novo; reativar grava ACCOUNT_ENABLED e não restaura sessões', async () => {
    const again = await post(`/platform/accounts/${x.id}/disable`, { reason: 'OTHER', code: CODE });
    assert.equal(again.statusCode, 204);
    assert.equal((await events(x.id)).length, 1);
    const enabled = await post(`/platform/accounts/${x.id}/enable`, { reason: 'OWNER_REQUEST' });
    assert.equal(enabled.statusCode, 204);
    assert.equal(await status(x.id), 'ACTIVE');
    assert.deepEqual(
      (await events(x.id)).map((event) => event.action),
      ['ACCOUNT_DISABLED', 'ACCOUNT_ENABLED'],
    );
    assert.equal(await sessionStatus(x.cookie), 401, 'a sessão antiga continua revogada');
  });

  it('Redis fora na revogação: 503 com a conta já desativada e a trilha gravada; repetir refaz só a revogação', async () => {
    x.cookie = await login(EMAIL_X, PASSWORD);
    fault.revokeAll = true;
    const failed = await post(`/platform/accounts/${x.id}/disable`, {
      reason: 'OTHER',
      code: CODE,
    });
    assert.equal(failed.statusCode, 503);
    assert.equal(await status(x.id), 'DISABLED');
    assert.equal((await events(x.id)).length, 3);
    // A conta desativada já barra o cookie (relido a cada requisição), mesmo sem a revogação.
    assert.equal(await sessionStatus(x.cookie), 401);
    fault.revokeAll = false;
    const retried = await post(`/platform/accounts/${x.id}/disable`, {
      reason: 'OTHER',
      code: CODE,
    });
    assert.equal(retried.statusCode, 204);
    assert.equal((await events(x.id)).length, 3, 'nenhum evento novo');
  });

  it('falha forçada na gravação da trilha: a conta não muda no banco', async () => {
    const real = new PrismaPlatformAccountUnitOfWork(database.prisma);
    const broken: PlatformAccountUnitOfWork = {
      run: (fn) =>
        real.run((tx) =>
          fn({ ...tx, audit: () => Promise.reject(new Error('trilha indisponível')) }),
        ),
    };
    const service = new PlatformAccountService({
      accounts: broken,
      confirmer: { confirmPlatformCode: () => Promise.resolve(Result.ok(undefined)) },
      accountSessions: { revokeAll: () => Promise.resolve() },
      bearerSessions: { revokeAllSessions: () => Promise.resolve() },
      mail: accountService,
      logger: logs.logger,
    });
    const identity = {
      kind: 'platform',
      adminId,
      sessionId: randomUUID(),
    } as const;
    await assert.rejects(service.setStatus(identity, z.id, 'DISABLED', 'OTHER', CODE));
    assert.equal(await status(z.id), 'ACTIVE');
    await assert.rejects(service.revokeSessions(identity, z.id, 'OTHER'));
    assert.deepEqual(await events(z.id), []);
  });

  it('código de recuperação pelo admin: 202 sempre; a conta confirmada e ativa recebe o código e ele troca a senha; segundo pedido em menos de 60 s não envia; não confirmada ou desativada não recebe nada', async () => {
    const url = `/platform/accounts/${y.id}/password-reset`;
    const first = await post(url, { reason: 'OWNER_REQUEST' });
    assert.equal(first.statusCode, 202);
    await accountService.drain();
    assert.deepEqual(resetSends, [EMAIL_Y]);
    const second = await post(url, { reason: 'OWNER_REQUEST' });
    assert.equal(second.statusCode, 202);
    await accountService.drain();
    assert.deepEqual(resetSends, [EMAIL_Y], 'menos de 60 s: nada sai');
    assert.deepEqual(
      (await events(y.id)).map((event) => event.action),
      ['ACCOUNT_PASSWORD_RESET_SENT', 'ACCOUNT_PASSWORD_RESET_SENT'],
    );
    const confirm = await site('/auth/password-reset/confirm', {
      email: EMAIL_Y,
      code: resetMail.get(EMAIL_Y),
      newPassword: NEW_PASSWORD,
    });
    assert.equal(confirm.statusCode, 204, confirm.body);
    assert.equal(await sessionStatus(y.cookie), 401, 'a 021 revoga as sessões');
    y.cookie = await login(EMAIL_Y, NEW_PASSWORD);

    // X está desativada; W não confirmada: 202, trilha, e nada sai.
    assert.equal(
      (await site('/auth/register', { email: EMAIL_W, password: PASSWORD })).statusCode,
      202,
    );
    await accountService.drain();
    const w = await accountId(EMAIL_W);
    clock += 2 * 60_000;
    for (const id of [x.id, w]) {
      assert.equal(
        (await post(`/platform/accounts/${id}/password-reset`, { reason: 'OTHER' })).statusCode,
        202,
      );
    }
    await accountService.drain();
    assert.deepEqual(resetSends, [EMAIL_Y]);
  });

  it('reenviar confirmação: só conta não confirmada (409 ALREADY_VERIFIED na confirmada, sem trilha); o código enviado confirma pelo /auth/verify-email', async () => {
    const w = await accountId(EMAIL_W);
    const verified = await post(`/platform/accounts/${y.id}/verification/resend`, {
      reason: 'OTHER',
    });
    assert.equal(verified.statusCode, 409);
    assert.equal(verified.json<{ error: { code: string } }>().error.code, 'ALREADY_VERIFIED');
    assert.ok(!(await events(y.id)).some((event) => event.action === 'ACCOUNT_VERIFICATION_SENT'));

    const before = verificationMail.get(EMAIL_W);
    clock += 2 * 60_000;
    const resent = await post(`/platform/accounts/${w}/verification/resend`, {
      reason: 'OWNER_REQUEST',
    });
    assert.equal(resent.statusCode, 202);
    await accountService.drain();
    const code = verificationMail.get(EMAIL_W);
    assert.ok(code !== undefined && code !== before, 'um código novo saiu');
    assert.deepEqual(
      (await events(w)).map((event) => event.action),
      ['ACCOUNT_PASSWORD_RESET_SENT', 'ACCOUNT_VERIFICATION_SENT'],
    );
    const confirmed = await site('/auth/verify-email', {
      email: EMAIL_W,
      password: PASSWORD,
      code,
    });
    assert.equal(confirmed.statusCode, 204, confirmed.body);
  });

  it('encerrar sessões: trilha e o cookie da conta passa a 401', async () => {
    assert.equal(await sessionStatus(y.cookie), 200);
    const response = await post(`/platform/accounts/${y.id}/sessions/revoke`, { reason: 'OTHER' });
    assert.equal(response.statusCode, 204);
    assert.equal(await sessionStatus(y.cookie), 401);
    assert.equal((await events(y.id)).at(-1)?.action, 'ACCOUNT_SESSIONS_REVOKED');
    assert.equal(await status(y.id), 'ACTIVE');
  });

  it('privacidade: nenhum e-mail nem código em resposta ou log; a trilha não tem e-mail', async () => {
    const raw = logs.raw();
    for (const address of [EMAIL_X, EMAIL_Y, EMAIL_Z, EMAIL_W]) {
      assert.ok(!bodies.some((body) => body.includes(address)), `resposta: ${address}`);
      assert.ok(!logContains(raw, address), `log: ${address}`);
    }
    for (const code of [...resetMail.values(), ...verificationMail.values()]) {
      assert.ok(!bodies.some((body) => logContains(body, code)), 'código em resposta');
    }
    const rows = await db().platformAuditEvent.findMany({ where: { adminId } });
    assert.ok(rows.length > 0);
    assert.ok(!JSON.stringify(rows).includes('@'), 'a trilha só tem ids e enums');
  });
});
