import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ServiceUnavailableError } from '../../shared/errors/index.js';
import type { AccountSessionStore } from '../../application/ports/account-session.js';
import { Result } from '../../shared/types/index.js';
import { test } from 'node:test';
import { AccountService } from '../../application/auth/account.service.js';
import { ClientService } from '../../application/clients/client.service.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { TestKeyspace } from '../../test-support/test-keyspace.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import {
  createDatabase,
  PrismaAccountRepository,
  PrismaClientRepository,
} from '../database/index.js';
import { createAuthRedis } from '../auth/auth-redis.js';
import { createAuthComponents } from '../auth/create-auth.js';
import { ScryptPasswordHasher } from '../auth/scrypt-password-hasher.js';
import { RedisAccountSessionStore } from '../auth/redis-account-session-store.js';
import { buildServer } from './server.js';

const config = loadIntegrationConfig();
test('conta global: confirmação, cookie, empresas, isolamento, revogação e privacidade', async () => {
  const logs = captureLogs();
  const db = createDatabase(config, logs.logger);
  const tenants = new TestTenants(db.prisma);
  const keys = new TestKeyspace();
  const prefix = keys.scopedPrefix('accounts');
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
  const mail = new Map<string, string>();
  let mailFails = false;
  const store = new RedisAccountSessionStore(redis.client, prefix);
  let sessionsDown = false;
  const sessions: AccountSessionStore = {
    create: (id) => store.create(id),
    select: (secret, clientId) => store.select(secret, clientId),
    revoke: (secret) => store.revoke(secret),
    read: (secret) =>
      sessionsDown
        ? Promise.reject(new ServiceUnavailableError('Sessão indisponível'))
        : store.read(secret),
  };
  const service = new AccountService({
    accounts: repo,
    passwords,
    sessions,
    loginLocks: auth.sessions,
    loginSecret: config.JWT_SECRET,
    mailer: {
      sendVerification: (email, token) => {
        if (mailFails) return Promise.reject(new Error('SMTP segredo que não pode vazar'));
        mail.set(email, token);
        return Promise.resolve();
      },
    },
  });
  const app = buildServer({
    logger: logs.logger,
    readiness: { database: () => db.check(), redis: () => Promise.resolve(Result.ok(undefined)) },
    auth: auth.service,
    userAdmin: auth.userAdmin,
    admin: { clients: new ClientService(new PrismaClientRepository(db.prisma)) },
    accounts: { service, origin: 'http://localhost:5174', secure: false },
  });
  const emails = [0, 1].map(() => `accounts-${randomUUID()}@example.test`);
  const password = `Secret1-${randomUUID()}`;
  const headers = { origin: 'http://localhost:5174', 'x-soprei-client': 'web' };
  const post = (url: string, payload: object, cookie?: string) =>
    app.inject({
      method: 'POST',
      url,
      payload,
      headers: { ...headers, ...(cookie ? { cookie } : {}) },
    });
  try {
    const cookieValues: string[] = [];
    for (const email of emails) {
      assert.equal((await post('/auth/register', { email, password: 'senha1' })).statusCode, 400);
      assert.equal((await post('/auth/register', { email, password })).statusCode, 202);
      assert.equal((await post('/auth/register', { email, password: 'Abcde1' })).statusCode, 202);
      assert.equal((await post('/auth/login', { email, password })).statusCode, 403);
      await service.drain();
      const token = mail.get(email);
      assert.ok(token);
      assert.equal(
        (await post('/auth/register', { email, password: 'Senha2-diferente' })).statusCode,
        202,
      );
      await service.drain();
      assert.equal(mail.get(email), token);
      assert.equal((await post('/auth/verify-email', { email, password, token })).statusCode, 204);
      assert.equal((await post('/auth/verify-email', { email, password, token })).statusCode, 401);
      const login = await post('/auth/login', { email, password });
      assert.equal(login.statusCode, 204);
      const setCookie = String(login.headers['set-cookie']);
      assert.match(setCookie, /HttpOnly; SameSite=Strict/);
      cookieValues.push(setCookie.split(';')[0] ?? '');
    }
    const [a, b] = cookieValues;
    assert.ok(a && b);
    const legacyClient = await tenants.createClient('legacy-account');
    const legacyEmail = `legacy-${randomUUID()}@example.test`;
    emails.push(legacyEmail);
    await auth.users.create(legacyClient.id, {
      email: legacyEmail,
      passwordHash: await passwords.hash(password),
      role: 'OWNER',
    });
    const legacyAuth = createAuthComponents({
      config: { ...config, ACCOUNTS_ENABLED: false, AUTH_REDIS_PREFIX: prefix },
      logger: logs.logger,
      prisma: db.prisma,
      authRedis: redis,
      hasher: passwords,
    });
    const oldLogin = await legacyAuth.service.login({
      clientSlug: legacyClient.slug,
      email: legacyEmail,
      password,
    });
    assert.ok(oldLogin.ok);
    assert.equal((await auth.service.authenticate(oldLogin.value.accessToken)).ok, false);
    assert.equal((await auth.service.refresh(oldLogin.value.refreshToken)).ok, false);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/auth/logout',
          payload: {},
          headers: { cookie: a, origin: 'http://evil.test' },
        })
      ).statusCode,
      403,
    );
    const legacyLogout = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      payload: { refreshToken: 'invalid-legacy-refresh' },
    });
    assert.equal(legacyLogout.statusCode, 204);
    assert.equal(legacyLogout.headers['set-cookie'], undefined);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/account/companies',
          payload: { name: 'evil' },
          headers: { cookie: a, origin: 'http://evil.test' },
        })
      ).statusCode,
      403,
    );
    const create = await post('/account/companies', { name: 'Empresa secreta A' }, a);
    assert.equal(create.statusCode, 201);
    const company = create.json<{ clientId: string; role: string }>();
    tenants.track(company.clientId);
    assert.equal(company.role, 'OWNER');
    const second = await post('/account/companies', { name: 'Segunda empresa A' }, a);
    assert.equal(second.statusCode, 201);
    const secondCompany = second.json<{ clientId: string }>();
    tenants.track(secondCompany.clientId);
    assert.equal(
      (await repo.listMemberships((await repo.findByEmail(emails[0] ?? ''))?.id ?? '')).length,
      2,
    );
    const ttlKeys = await keys.keysUnder(redis.client, prefix);
    const sessionKeys = ttlKeys.filter((key) => key.includes('account-session:'));
    assert.equal(sessionKeys.length, 2);
    for (const key of sessionKeys) {
      assert.ok((await redis.client.ttl(key)) > 0);
      assert.ok(!(await redis.client.get(key))?.includes(a.slice('soprei_session='.length)));
    }
    const listB = await app.inject({ url: '/account/companies', headers: { cookie: b } });
    assert.deepEqual(listB.json<{ items: unknown[] }>().items, []);
    assert.equal(
      (
        await app.inject({
          url: `/admin/clients/${company.clientId}/users`,
          headers: { cookie: b },
        })
      ).statusCode,
      401,
    );
    const ownB = await post('/account/companies', { name: 'Empresa B' }, b);
    assert.equal(ownB.statusCode, 201);
    const companyB = ownB.json<{ clientId: string }>();
    tenants.track(companyB.clientId);
    assert.equal(
      (await post(`/account/companies/${company.clientId}/select`, {}, b)).statusCode,
      404,
    );
    assert.equal(
      (await post(`/account/companies/${company.clientId}/select`, {}, a)).statusCode,
      204,
    );
    assert.equal(
      (
        await app.inject({
          url: `/admin/clients/${company.clientId}/users`,
          headers: { cookie: a },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          url: `/admin/clients/${companyB.clientId}/users`,
          headers: { cookie: a },
        })
      ).statusCode,
      404,
    );
    const session = await app.inject({ url: '/auth/session', headers: { cookie: a } });
    const privateCacheCheck = await app.inject({
      url: `/admin/clients/${company.clientId}/users`,
      headers: { cookie: a },
    });
    assert.equal(privateCacheCheck.headers['cache-control'], 'no-store');
    assert.equal(session.json<{ selectedClientId: string }>().selectedClientId, company.clientId);
    // Mutações com cookie sem Origin/cabeçalho do app são recusadas (CSRF), também em rota de tenant.
    for (const request of [
      { method: 'POST', url: '/account/companies', payload: { name: 'sem origem' } },
      {
        method: 'PATCH',
        url: `/admin/clients/${company.clientId}/users/${randomUUID()}`,
        payload: { role: 'VIEWER' },
      },
    ] as const) {
      assert.equal((await app.inject({ ...request, headers: { cookie: a } })).statusCode, 403);
    }
    // Redis das sessões fora: fail-closed (503), nunca aceita o cookie sem poder conferir.
    sessionsDown = true;
    for (const url of ['/auth/session', `/admin/clients/${company.clientId}/users`]) {
      assert.equal((await app.inject({ url, headers: { cookie: a } })).statusCode, 503);
    }
    sessionsDown = false;
    assert.equal(session.headers['set-cookie'], undefined);
    await db.prisma.user.updateMany({
      where: { clientId: company.clientId },
      data: { role: 'VIEWER' },
    });
    assert.equal((await service.tenantIdentity(a.slice('soprei_session='.length)))?.role, 'VIEWER');
    await service.selectCompany(a.slice('soprei_session='.length), secondCompany.clientId);
    assert.equal((await service.tenantIdentity(a.slice('soprei_session='.length)))?.role, 'OWNER');
    await service.selectCompany(a.slice('soprei_session='.length), company.clientId);
    const creation = await Promise.allSettled(
      Array.from({ length: 19 }, (_, index) =>
        service.createCompany(a.slice('soprei_session='.length), `Limite concorrente ${index}`),
      ),
    );
    for (const result of creation)
      if (result.status === 'fulfilled') tenants.track(result.value.clientId);
    assert.equal(creation.filter((result) => result.status === 'fulfilled').length, 18);
    assert.equal((await service.companies(a.slice('soprei_session='.length))).length, 20);
    const accountA = await repo.findByEmail(emails[0] ?? '');
    assert.ok(accountA);
    const expired = randomBytes(32).toString('base64url');
    const expiredKey = `${prefix}account-session:${createHash('sha256').update(expired).digest('hex')}`;
    await redis.client.set(
      expiredKey,
      JSON.stringify({
        accountId: accountA.id,
        id: randomUUID(),
        clientId: null,
        createdAt: 0,
        expiresAt: 1,
      }),
      'EX',
      60,
    );
    assert.equal(await store.read(expired), null);
    assert.equal(await redis.client.exists(expiredKey), 0);
    // Em novo request, o vínculo é relido; desativá-lo não conserva a identidade anterior.
    await db.prisma.user.updateMany({
      where: { clientId: company.clientId },
      data: { status: 'DISABLED' },
    });
    assert.equal(
      (await post(`/account/companies/${company.clientId}/select`, {}, a)).statusCode,
      404,
    );
    const secret = a.slice('soprei_session='.length);
    await assert.rejects(service.tenantIdentity(secret));
    const accountB = await repo.findByEmail(emails[1] ?? '');
    assert.ok(accountB);
    await db.prisma.account.update({ where: { id: accountB.id }, data: { status: 'DISABLED' } });
    assert.equal(
      (await app.inject({ url: '/auth/session', headers: { cookie: b } })).statusCode,
      401,
    );
    assert.equal((await post('/auth/logout', {}, a)).statusCode, 204);
    assert.equal(await store.read(secret), null);
    assert.equal(
      (await app.inject({ url: '/auth/session', headers: { cookie: a } })).statusCode,
      401,
    );
    const secureApp = buildServer({
      logger: logs.logger,
      readiness: { database: () => db.check(), redis: () => Promise.resolve(Result.ok(undefined)) },
      accounts: { service, origin: 'https://soprei.example', secure: true },
    });
    try {
      const secureLogin = await secureApp.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { origin: 'https://soprei.example', 'x-soprei-client': 'web' },
        payload: { email: emails[0], password },
      });
      assert.equal(secureLogin.statusCode, 204);
      assert.match(String(secureLogin.headers['set-cookie']), /; Secure/);
    } finally {
      await secureApp.close();
    }
    // Falha de envio não confirma conta; reenvio autenticado permite recuperar.
    const recoverEmail = `recover-${randomUUID()}@example.test`;
    emails.push(recoverEmail);
    mailFails = true;
    // Falhas externas são sanitizadas pelo mailer de produção. Aqui a porta rejeita sem corpo SMTP.
    // Falha de SMTP não vira 503 no cadastro (não revela existência); o envio é em segundo plano.
    assert.equal((await post('/auth/register', { email: recoverEmail, password })).statusCode, 202);
    await service.drain();
    assert.equal(mail.has(recoverEmail), false);
    assert.equal((await repo.findByEmail(recoverEmail))?.emailVerifiedAt, null);
    mailFails = false;
    assert.equal(
      (await post('/auth/resend-verification', { email: recoverEmail, password })).statusCode,
      202,
    );
    const recoverToken = mail.get(recoverEmail);
    assert.ok(recoverToken);
    const recovery = await repo.findByEmail(recoverEmail);
    assert.ok(recovery);
    await repo.setVerification(recovery.id, 'expired-hash', new Date(0));
    assert.equal(
      (await post('/auth/verify-email', { email: recoverEmail, password, token: recoverToken }))
        .statusCode,
      401,
    );
    for (const value of [
      password,
      ...emails,
      ...mail.values(),
      secret,
      'Empresa secreta A',
      'SMTP segredo',
    ])
      assert.ok(!logs.raw().includes(value));
  } finally {
    await app.close();
    await tenants.cleanup();
    await db.prisma.account.deleteMany({ where: { email: { in: emails } } });
    await keys.cleanup(redis.client);
    await redis.close();
    await db.close();
  }
});
