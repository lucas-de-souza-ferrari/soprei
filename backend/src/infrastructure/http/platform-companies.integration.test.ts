import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { AccountService } from '../../application/auth/account.service.js';
import type { PlatformCompanyUnitOfWork } from '../../application/ports/platform-company-unit-of-work.js';
import { PlatformAuthService } from '../../application/platform/platform-auth.service.js';
import { PlatformCompanyService } from '../../application/platform/platform-company.service.js';
import { factorFingerprint } from '../../application/platform/totp-second-factor.js';
import { AccountId, type Company, type PlatformAdminId } from '../../domain/index.js';
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
  PrismaPlatformAdminRepository,
  PrismaPlatformAuditRepository,
  PrismaPlatformCompanyUnitOfWork,
  PrismaPlatformReadModel,
} from '../database/index.js';
import { createMetrics } from '../metrics/index.js';
import { buildServer } from './server.js';

// Spec 045, E3a: as ações do admin da plataforma sobre empresas e vínculos com Postgres (soprei_test) e
// Redis (/15) reais. A conferência do código do autenticador tem teste próprio com o TOTP de verdade
// (`platform-company.controller.test.ts`); aqui ela é um dublê que aceita só `CODE`.

const config = loadIntegrationConfig();
const keyspace = new TestKeyspace();
const ORIGIN = 'https://soadm.exemplo.test';
const SITE = 'http://localhost:5174';
const WRITE = { origin: ORIGIN, 'x-soprei-app': 'admin' } as const;
const SITE_HEADERS = { origin: SITE, 'x-soprei-app': 'web' } as const;
const CODE = '123456';

const tag = randomBytes(4).toString('hex');
const email = (label: string): string => `plat-e3-${label}-${tag}@exemplo.test`;
const EMAIL_X = email('x');
const EMAIL_Y = email('y');
const INVITED = email('convidada');
const PASSWORD = `Senha1-${randomUUID()}`;

let database: Database;
let tenants: TestTenants;
let authRedis: AuthRedisHandle;
let auth: AuthComponents;
let app: FastifyInstance;
let accountService: AccountService;
const logs = captureLogs();
let cookie: string;
let adminId: PlatformAdminId;
const createdAdmins: string[] = [];
const verificationMail = new Map<string, string>();
const bearerCalls: string[] = [];
const unsubscribed: string[] = [];
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
  const row = await db().account.findUnique({ where: { email: address }, select: { id: true } });
  assert.ok(row);
  const login = await site('/auth/login', { email: address, password: PASSWORD });
  assert.equal(login.statusCode, 204, login.body);
  return {
    id: AccountId.parse(row.id),
    cookie: String(login.headers['set-cookie']).split(';')[0] ?? '',
  };
}

async function member(
  company: Company,
  account: AccountId | null,
  role: 'OWNER' | 'ADMIN' | 'AGENT',
  label: string,
): Promise<string> {
  const row = await db().membership.create({
    data: {
      companyId: company.id,
      email: `${label}-${tag}@exemplo.test`,
      passwordHash: 'x',
      role,
      ...(account === null ? {} : { accountId: account }),
    },
  });
  return row.id;
}

async function membership(company: Company, id: string) {
  return db().membership.findFirst({
    where: { id, companyId: company.id },
    select: { role: true, status: true },
  });
}

async function companyEvents(company: Company) {
  return db().platformAuditEvent.findMany({
    where: { adminId, subjectCompanyId: company.id },
    orderBy: { createdAt: 'asc' },
    select: {
      action: true,
      reason: true,
      subjectMembershipId: true,
      fromRole: true,
      toRole: true,
    },
  });
}

async function companyIds(siteCookie: string): Promise<string[]> {
  const response = await app.inject({ url: '/account/companies', headers: { cookie: siteCookie } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<{ items: { companyId: string }[] }>().items.map((item) => item.companyId);
}

before(async () => {
  database = createDatabase(config, logs.logger);
  tenants = new TestTenants(database.prisma);
  authRedis = createAuthRedis(config, logs.logger);
  assert.ok(await authRedis.waitUntilReady(5_000));
  const prefix = keyspace.scopedPrefix('platform-companies-e3');
  const passwords = new ScryptPasswordHasher({ cost: { N: 1024, r: 8, p: 1 } });
  auth = createAuthComponents({
    config: { ...config, ACCOUNTS_ENABLED: true, AUTH_REDIS_PREFIX: prefix },
    logger: logs.logger,
    prisma: database.prisma,
    authRedis,
    hasher: passwords,
  });
  let counter = 600_000;
  accountService = new AccountService({
    accounts: new PrismaAccountRepository(database.prisma),
    passwords,
    sessions: new RedisAccountSessionStore(authRedis.client, prefix),
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

  const admins = new PrismaPlatformAdminRepository(database.prisma);
  const admin = await admins.create({ email: `adm-e3-${tag}@exemplo.test`, passwordHash: 'x' });
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
      companies: new PlatformCompanyService({
        companies: new PrismaPlatformCompanyUnitOfWork(database.prisma),
        confirmer: {
          confirmPlatformCode: (id, code) => {
            assert.equal(id, adminId);
            return Promise.resolve(
              code === CODE ? Result.ok(undefined) : Result.err({ reason: 'invalid_credentials' }),
            );
          },
        },
        bearerSessions: {
          revokeAllSessions: (scope, subject) => {
            bearerCalls.push(`${scope}:${subject}`);
            return auth.sessions.revokeAllSessions(scope, subject);
          },
        },
        channel: {
          unsubscribeRemoved: (companyId, removed) => {
            unsubscribed.push(`${companyId}:${removed.wabaId}`);
            return Promise.resolve();
          },
        },
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
    await db().platformAuditEvent.deleteMany({ where: { adminId: { in: createdAdmins } } });
    await tenants.cleanup();
    await db().account.deleteMany({ where: { email: { in: [EMAIL_X, EMAIL_Y] } } });
    await db().platformAdmin.deleteMany({ where: { id: { in: createdAdmins } } });
    await keyspace.cleanup(authRedis.client);
  } finally {
    await authRedis.close();
    await database.close();
  }
});

describe('ações do admin da plataforma sobre empresas e vínculos com Postgres e Redis reais (spec 045, E3a)', () => {
  let x: { id: AccountId; cookie: string };
  let y: { id: AccountId; cookie: string };
  let companyA: Company;
  let companyB: Company;
  let ownerX = '';
  let agentY = '';
  let foreign = '';

  it('mudar papel: o último dono = 409 LAST_OWNER; promover Y e rebaixar X transfere a propriedade; vínculo de outra empresa = 404 e nada muda', async () => {
    x = await confirmedAccount(EMAIL_X);
    y = await confirmedAccount(EMAIL_Y);
    companyA = await tenants.createCompany('pe3-a');
    companyB = await tenants.createCompany('pe3-b');
    ownerX = await member(companyA, x.id, 'OWNER', 'xa');
    agentY = await member(companyA, y.id, 'AGENT', 'ya');
    foreign = await member(companyB, y.id, 'OWNER', 'yb');
    const base = `/platform/companies/${companyA.id}/memberships`;

    const last = await post(`${base}/${ownerX}/role`, {
      role: 'ADMIN',
      reason: 'OTHER',
      code: CODE,
    });
    assert.equal(last.statusCode, 409, last.body);
    assert.equal(last.json<{ error: { code: string } }>().error.code, 'LAST_OWNER');

    const crossed = await post(`${base}/${foreign}/role`, { role: 'VIEWER', reason: 'OTHER' });
    assert.equal(crossed.statusCode, 404);
    assert.equal((await membership(companyB, foreign))?.role, 'OWNER');

    for (const [id, role] of [
      [agentY, 'OWNER'],
      [ownerX, 'ADMIN'],
    ] as const) {
      const response = await post(`${base}/${id}/role`, {
        role,
        reason: 'OWNER_REQUEST',
        code: CODE,
      });
      assert.equal(response.statusCode, 204, response.body);
    }
    assert.equal((await membership(companyA, agentY))?.role, 'OWNER');
    assert.equal((await membership(companyA, ownerX))?.role, 'ADMIN');
    assert.deepEqual(await companyEvents(companyA), [
      {
        action: 'MEMBERSHIP_ROLE_CHANGED_BY_PLATFORM',
        reason: 'OWNER_REQUEST',
        subjectMembershipId: agentY,
        fromRole: 'AGENT',
        toRole: 'OWNER',
      },
      {
        action: 'MEMBERSHIP_ROLE_CHANGED_BY_PLATFORM',
        reason: 'OWNER_REQUEST',
        subjectMembershipId: ownerX,
        fromRole: 'OWNER',
        toRole: 'ADMIN',
      },
    ]);
    assert.deepEqual(bearerCalls, [`${companyA.id}:${agentY}`, `${companyA.id}:${ownerX}`]);
  });

  it('duas transferências concorrentes (rebaixar cada um dos dois donos) nunca deixam a empresa sem dono ativo', async () => {
    const company = await tenants.createCompany('pe3-c');
    const first = await member(company, x.id, 'OWNER', 'xc');
    const second = await member(company, y.id, 'OWNER', 'yc');
    const base = `/platform/companies/${company.id}/memberships`;
    const results = await Promise.all([
      post(`${base}/${first}/role`, { role: 'ADMIN', reason: 'OTHER', code: CODE }),
      post(`${base}/${second}/role`, { role: 'ADMIN', reason: 'OTHER', code: CODE }),
    ]);
    assert.deepEqual(results.map((response) => response.statusCode).sort(), [204, 409]);
    const owners = await db().membership.count({
      where: { companyId: company.id, role: 'OWNER', status: 'ACTIVE' },
    });
    assert.equal(owners, 1);
  });

  it('desativar e reativar o vínculo: o último dono = 409; a pessoa perde a empresa na requisição seguinte', async () => {
    const base = `/platform/companies/${companyA.id}/memberships`;
    const blocked = await post(`${base}/${agentY}/disable`, { reason: 'OTHER' });
    assert.equal(blocked.statusCode, 409);
    assert.ok((await companyIds(x.cookie)).includes(companyA.id));
    const disabled = await post(`${base}/${ownerX}/disable`, { reason: 'ABUSE' });
    assert.equal(disabled.statusCode, 204);
    assert.equal((await membership(companyA, ownerX))?.status, 'DISABLED');
    assert.ok(!(await companyIds(x.cookie)).includes(companyA.id));
    const enabled = await post(`${base}/${ownerX}/enable`, { reason: 'OTHER' });
    assert.equal(enabled.statusCode, 204);
    assert.ok((await companyIds(x.cookie)).includes(companyA.id));
    const actions = (await companyEvents(companyA)).map((event) => event.action);
    assert.deepEqual(actions.slice(-2), [
      'MEMBERSHIP_DISABLED_BY_PLATFORM',
      'MEMBERSHIP_ENABLED_BY_PLATFORM',
    ]);
  });

  it('renomear: grava o nome e a trilha (sem o nome); o mesmo nome não grava evento', async () => {
    const before = (await companyEvents(companyA)).length;
    const renamed = await post(`/platform/companies/${companyA.id}/rename`, {
      name: 'Nome Sigiloso Novo',
      reason: 'OWNER_REQUEST',
    });
    assert.equal(renamed.statusCode, 204);
    const again = await post(`/platform/companies/${companyA.id}/rename`, {
      name: 'Nome Sigiloso Novo',
      reason: 'OWNER_REQUEST',
    });
    assert.equal(again.statusCode, 204);
    const row = await db().company.findFirst({
      where: { id: companyA.id },
      select: { name: true },
    });
    assert.equal(row?.name, 'Nome Sigiloso Novo');
    assert.equal((await companyEvents(companyA)).length, before + 1);
  });

  it('remover: slug errado = 400 sem efeito; certo = soft delete, número liberado, conexão apagada, convites revogados, desassinatura; os membros perdem a empresa; aparece em status=removed; restaurar devolve sem canal', async () => {
    await db().company.updateMany({
      where: { id: companyA.id },
      data: { whatsappPhoneNumberId: `9${String(Date.now()).slice(-12)}` },
    });
    await db().channelConnection.create({
      data: { companyId: companyA.id, wabaId: '1029384756', tokenCiphertext: 'v1.k1.cifrado' },
    });
    const invitation = await db().companyInvitation.create({
      data: {
        companyId: companyA.id,
        email: INVITED,
        role: 'AGENT',
        tokenHash: 'h'.repeat(64),
        invitedByMembershipId: agentY,
        expiresAt: new Date(Date.now() + 86_400_000),
        lastSentAt: new Date(),
      },
    });
    const url = `/platform/companies/${companyA.id}/remove`;
    const mismatch = await post(url, { reason: 'ABUSE', slug: 'nao-e-este', code: CODE });
    assert.equal(mismatch.statusCode, 400);
    assert.equal(mismatch.json<{ error: { code: string } }>().error.code, 'CONFIRMATION_MISMATCH');
    assert.equal(
      (await db().company.findFirst({ where: { id: companyA.id }, select: { deletedAt: true } }))
        ?.deletedAt,
      null,
    );

    const removed = await post(url, { reason: 'ABUSE', slug: companyA.slug, code: CODE });
    assert.equal(removed.statusCode, 204, removed.body);
    const row = await db().company.findFirst({
      where: { id: companyA.id },
      select: { deletedAt: true, whatsappPhoneNumberId: true },
    });
    assert.notEqual(row?.deletedAt, null);
    assert.equal(row?.whatsappPhoneNumberId, null);
    assert.equal(await db().channelConnection.count({ where: { companyId: companyA.id } }), 0);
    const closed = await db().companyInvitation.findFirst({
      where: { id: invitation.id, companyId: companyA.id },
      select: { status: true, email: true, tokenHash: true },
    });
    assert.deepEqual(closed, { status: 'REVOKED', email: null, tokenHash: null });
    assert.deepEqual(unsubscribed, [`${companyA.id}:1029384756`]);
    assert.ok(!(await companyIds(y.cookie)).includes(companyA.id));
    assert.ok((await companyIds(y.cookie)).includes(companyB.id));

    // A leitura do admin: a removida só aparece no filtro próprio e o detalhe responde com removedAt.
    const reads = new PrismaPlatformReadModel(database.prisma);
    const now = new Date();
    const active = await reads.listCompanies({}, { limit: 50 }, now);
    assert.ok(!active.items.some((item) => item.id === companyA.id));
    let found = false;
    let cursor: string | undefined;
    do {
      const page = await reads.listCompanies(
        { removed: true },
        { limit: 50, ...(cursor === undefined ? {} : { cursor }) },
        now,
      );
      found ||= page.items.some((item) => item.id === companyA.id && item.removedAt !== null);
      cursor = page.nextCursor ?? undefined;
    } while (!found && cursor !== undefined);
    assert.ok(found, 'a removida aparece em status=removed');
    assert.notEqual((await reads.companyDetail(companyA.id, now))?.company.removedAt, null);

    // Remover de novo: 404 (já removida).
    assert.equal(
      (await post(url, { reason: 'ABUSE', slug: companyA.slug, code: CODE })).statusCode,
      404,
    );

    const restored = await post(`/platform/companies/${companyA.id}/restore`, {
      reason: 'OWNER_REQUEST',
      code: CODE,
    });
    assert.equal(restored.statusCode, 204);
    const back = await db().company.findFirst({
      where: { id: companyA.id },
      select: { deletedAt: true, whatsappPhoneNumberId: true },
    });
    assert.deepEqual(back, { deletedAt: null, whatsappPhoneNumberId: null });
    assert.equal(await db().channelConnection.count({ where: { companyId: companyA.id } }), 0);
    assert.ok((await companyIds(y.cookie)).includes(companyA.id));
    const actions = (await companyEvents(companyA)).map((event) => event.action);
    assert.deepEqual(actions.slice(-2), ['COMPANY_REMOVED', 'COMPANY_RESTORED']);
  });

  it('falha forçada na gravação da trilha ao remover: empresa, número, conexão e convite ficam como estavam (rollback real)', async () => {
    const company = await tenants.createCompany('pe3-f', `8${String(Date.now()).slice(-12)}`);
    const inviter = await member(company, x.id, 'OWNER', 'xf');
    await db().channelConnection.create({
      data: { companyId: company.id, wabaId: '5647382910', tokenCiphertext: 'v1.k1.cifrado' },
    });
    const invitation = await db().companyInvitation.create({
      data: {
        companyId: company.id,
        email: email('falha'),
        role: 'AGENT',
        tokenHash: 'f'.repeat(64),
        invitedByMembershipId: inviter,
        expiresAt: new Date(Date.now() + 86_400_000),
        lastSentAt: new Date(),
      },
    });
    const real = new PrismaPlatformCompanyUnitOfWork(database.prisma);
    const broken: PlatformCompanyUnitOfWork = {
      run: (fn) =>
        real.run((tx) =>
          fn({ ...tx, audit: () => Promise.reject(new Error('trilha indisponível')) }),
        ),
    };
    const service = new PlatformCompanyService({
      companies: broken,
      confirmer: { confirmPlatformCode: () => Promise.resolve(Result.ok(undefined)) },
      bearerSessions: { revokeAllSessions: () => Promise.resolve() },
      logger: logs.logger,
    });
    const identity = { kind: 'platform', adminId, sessionId: randomUUID() } as const;
    await assert.rejects(service.remove(identity, company.id, company.slug, 'OTHER', CODE));
    const row = await db().company.findFirst({
      where: { id: company.id },
      select: { deletedAt: true, whatsappPhoneNumberId: true },
    });
    assert.ok(row);
    assert.equal(row.deletedAt, null);
    assert.equal(row.whatsappPhoneNumberId, company.whatsappPhoneNumberId);
    assert.equal(await db().channelConnection.count({ where: { companyId: company.id } }), 1);
    const pending = await db().companyInvitation.findFirst({
      where: { id: invitation.id, companyId: company.id },
      select: { status: true },
    });
    assert.equal(pending?.status, 'PENDING');
    assert.deepEqual(await companyEvents(company), []);
  });

  it('privacidade: nenhum nome de empresa, slug, e-mail ou código em resposta ou log; a trilha não tem texto livre', () => {
    const raw = logs.raw();
    for (const secret of ['Nome Sigiloso Novo', companyA.slug, EMAIL_X, EMAIL_Y, INVITED]) {
      assert.ok(!logContains(raw, secret), `log: ${secret}`);
      for (const body of bodies) assert.ok(!body.includes(secret), `resposta: ${secret}`);
    }
    for (const body of bodies) assert.ok(!logContains(body, CODE), 'código em resposta');
  });
});
