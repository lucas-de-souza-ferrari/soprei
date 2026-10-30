import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ClientService } from '../../application/clients/client.service.js';
import type { Client } from '../../domain/index.js';
import { buildServer } from '../../infrastructure/http/server.js';
import { createMetrics, type Metrics } from '../../infrastructure/metrics/index.js';
import { ServiceUnavailableError } from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import {
  bearer,
  buildTestAuth,
  InMemorySessionStore,
  type IssuedLogin,
  type TestAuth,
  TEST_PASSWORD,
} from '../../test-support/in-memory-auth.js';
import { captureLogs, type LogCapture } from '../../test-support/log-capture.js';

const NEW_PASSWORD = 'uma-senha-nova-bem-longa-9';
const SECRET_NEW = 'senha-nova-ultra-secreta-55';
const SECRET_WRONG = 'senha-errada-ultra-secreta-66';

interface Env {
  app: FastifyInstance;
  auth: TestAuth;
  logs: LogCapture;
  metrics: Metrics;
  store: InMemorySessionStore;
  client: Client;
  other: Client;
}

async function setup(): Promise<Env> {
  const logs = captureLogs();
  const metrics = createMetrics();
  const store = new InMemorySessionStore({ maxFailures: 3, lockSeconds: 900 });
  const auth = buildTestAuth({ logger: logs.logger, metrics, sessions: store, maxFailures: 3 });
  const app = buildServer({
    logger: logs.logger,
    metrics,
    readiness: {
      database: () => Promise.resolve(Result.ok(undefined)),
      redis: () => Promise.resolve(Result.ok(undefined)),
    },
    auth: auth.service,
    userAdmin: auth.userAdmin,
    admin: { clients: new ClientService(auth.clients) },
  });
  await app.ready();
  const client = await auth.clients.create({ name: 'Cliente A', slug: 'cliente-a' });
  const other = await auth.clients.create({ name: 'Cliente B', slug: 'cliente-b' });
  return { app, auth, logs, metrics, store, client, other };
}

describe('POST /auth/password (troca da própria senha), spec 008', () => {
  let env: Env;
  beforeEach(async () => {
    env = await setup();
  });
  afterEach(async () => {
    await env.app.close();
  });

  const change = (who: IssuedLogin | undefined, payload: object) =>
    env.app.inject({
      method: 'POST',
      url: '/auth/password',
      ...(who === undefined ? {} : { headers: bearer(who.accessToken) }),
      payload,
    });
  const me = (who: IssuedLogin) =>
    env.app.inject({ method: 'GET', url: '/auth/me', headers: bearer(who.accessToken) });
  const loginAs = (client: Client, who: IssuedLogin, password: string) =>
    env.auth.service.login({ clientSlug: client.slug, email: who.email, password });

  it('senha atual errada é 401 e conta no contador: depois do limite, 429 com Retry-After antes de gastar hash', async () => {
    const who = await env.auth.userToken(env.client.id, { role: 'AGENT' });
    for (let i = 0; i < 3; i += 1) {
      const response = await change(who, {
        currentPassword: SECRET_WRONG,
        newPassword: NEW_PASSWORD,
      });
      assert.equal(response.statusCode, 401);
    }
    const verifyBefore = env.auth.hasher.verifyCalls;
    const hashBefore = env.auth.hasher.hashCalls;
    // Bloqueada: até a senha CERTA recebe 429, sem verificar nem gerar hash.
    for (const currentPassword of [SECRET_WRONG, TEST_PASSWORD]) {
      const locked = await change(who, { currentPassword, newPassword: NEW_PASSWORD });
      assert.equal(locked.statusCode, 429);
      assert.equal(locked.headers['retry-after'], '900');
      assert.equal(locked.json<{ error: { code: string } }>().error.code, 'RATE_LIMITED');
    }
    assert.equal(env.auth.hasher.verifyCalls, verifyBefore);
    assert.equal(env.auth.hasher.hashCalls, hashBefore);
    // A senha não mudou.
    assert.ok((await loginAs(env.client, who, TEST_PASSWORD)).ok);
  });

  it('o contador é por pessoa: bloquear uma não bloqueia outra do mesmo cliente nem a do outro cliente', async () => {
    const victim = await env.auth.userToken(env.client.id, { role: 'AGENT' });
    const bystander = await env.auth.userToken(env.client.id, { role: 'AGENT' });
    const alien = await env.auth.userToken(env.other.id, { role: 'AGENT' });
    for (let i = 0; i < 3; i += 1) {
      await change(victim, { currentPassword: SECRET_WRONG, newPassword: NEW_PASSWORD });
    }
    assert.equal(
      (await change(victim, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD }))
        .statusCode,
      429,
    );
    for (const who of [bystander, alien]) {
      assert.equal(
        (await change(who, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD }))
          .statusCode,
        204,
      );
    }
  });

  it('a senha certa troca o hash, devolve 204 sem corpo e derruba TODAS as sessões da pessoa (access e refresh)', async () => {
    const who = await env.auth.userToken(env.client.id, { role: 'VIEWER' });
    const second = await loginAs(env.client, who, TEST_PASSWORD);
    assert.ok(second.ok);
    const bystander = await env.auth.userToken(env.client.id, { role: 'AGENT' });
    const alien = await env.auth.userToken(env.other.id, { role: 'OWNER' });

    const response = await change(who, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    assert.equal(response.statusCode, 204);
    assert.equal(response.body, '');

    assert.equal((await me(who)).statusCode, 401, 'a sessão atual cai');
    assert.equal(
      (
        await env.app.inject({
          method: 'GET',
          url: '/auth/me',
          headers: bearer(second.value.accessToken),
        })
      ).statusCode,
      401,
      'a outra sessão da pessoa cai',
    );
    for (const refreshToken of [who.refreshToken, second.value.refreshToken]) {
      const refresh = await env.app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refreshToken },
      });
      assert.equal(refresh.statusCode, 401);
    }
    assert.equal((await me(bystander)).statusCode, 200);
    assert.equal((await me(alien)).statusCode, 200);

    assert.ok(!(await loginAs(env.client, who, TEST_PASSWORD)).ok);
    assert.ok((await loginAs(env.client, who, NEW_PASSWORD)).ok);
  });

  it('senha nova igual à atual é aceita; o papel não é pré-requisito (VIEWER troca a sua)', async () => {
    const who = await env.auth.userToken(env.client.id, { role: 'VIEWER' });
    const response = await change(who, {
      currentPassword: TEST_PASSWORD,
      newPassword: TEST_PASSWORD,
    });
    assert.equal(response.statusCode, 204);
    assert.ok((await loginAs(env.client, who, TEST_PASSWORD)).ok);
  });

  it('grava USER_PASSWORD_CHANGED com ator = alvo, sem papéis; um acerto zera o contador', async () => {
    const who = await env.auth.userToken(env.client.id, { role: 'AGENT' });
    for (let i = 0; i < 2; i += 1) {
      await change(who, { currentPassword: SECRET_WRONG, newPassword: NEW_PASSWORD });
    }
    assert.equal(
      (await change(who, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD })).statusCode,
      204,
    );
    const [event] = env.auth.audit.events;
    assert.ok(event);
    assert.equal(event.action, 'USER_PASSWORD_CHANGED');
    assert.equal(event.actorUserId, who.userId);
    assert.equal(event.targetUserId, who.userId);
    assert.equal(event.clientId, env.client.id);
    assert.equal(event.fromRole, null);
    assert.equal(event.toRole, null);
    // Contador zerado: depois do acerto, duas falhas novas ainda não bloqueiam.
    const fresh = await loginAs(env.client, who, NEW_PASSWORD);
    assert.ok(fresh.ok);
    const { accessToken } = fresh.value;
    for (let i = 0; i < 2; i += 1) {
      const wrong = await env.app.inject({
        method: 'POST',
        url: '/auth/password',
        headers: bearer(accessToken),
        payload: { currentPassword: SECRET_WRONG, newPassword: NEW_PASSWORD },
      });
      assert.equal(wrong.statusCode, 401);
    }
  });

  it('sem token 401; PlatformAdmin 403; corpo inválido 400 sem ecoar a senha', async () => {
    const platform = await env.auth.platformToken();
    const who = await env.auth.userToken(env.client.id, { role: 'AGENT' });
    assert.equal(
      (await change(undefined, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD }))
        .statusCode,
      401,
    );
    assert.equal(
      (await change(platform, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD }))
        .statusCode,
      403,
    );
    for (const payload of [
      { currentPassword: TEST_PASSWORD, newPassword: 'curta' },
      { currentPassword: TEST_PASSWORD, newPassword: `${SECRET_NEW}\u0000` },
      { currentPassword: TEST_PASSWORD },
      { newPassword: SECRET_NEW },
      { currentPassword: TEST_PASSWORD, newPassword: SECRET_NEW, extra: SECRET_NEW },
      { currentPassword: '', newPassword: SECRET_NEW },
    ]) {
      const response = await change(who, payload);
      assert.equal(response.statusCode, 400, JSON.stringify(Object.keys(payload)));
      assert.ok(!response.body.includes(SECRET_NEW));
      assert.ok(!response.body.includes(TEST_PASSWORD));
    }
  });

  it('Redis das sessões fora: 503 sem verificar a senha (a rota é autenticada, então o hook já falha fechado)', async () => {
    const who = await env.auth.userToken(env.client.id, { role: 'AGENT' });
    env.store.failWith = new ServiceUnavailableError('redis fora');
    const before = env.auth.hasher.verifyCalls;
    const response = await change(who, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    assert.equal(response.statusCode, 503);
    assert.equal(env.auth.hasher.verifyCalls, before);
  });

  it('Redis fora DEPOIS do commit: 503, a senha nova e a auditoria ficam gravadas', async () => {
    const who = await env.auth.userToken(env.client.id, { role: 'AGENT' });
    env.store.failRevokeAllWith = new ServiceUnavailableError('redis fora');
    const response = await change(who, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    assert.equal(response.statusCode, 503);
    env.store.failRevokeAllWith = undefined;
    assert.equal(env.auth.audit.events.length, 1);
    assert.ok((await loginAs(env.client, who, NEW_PASSWORD)).ok);
    assert.ok(!(await loginAs(env.client, who, TEST_PASSWORD)).ok);
  });

  it('falha ao gravar a trilha desfaz a troca de senha', async () => {
    const who = await env.auth.userToken(env.client.id, { role: 'AGENT' });
    env.auth.audit.failWith = new Error('falha de teste na trilha');
    const response = await change(who, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    assert.equal(response.statusCode, 500);
    env.auth.audit.failWith = undefined;
    assert.ok(
      (await loginAs(env.client, who, TEST_PASSWORD)).ok,
      'a senha antiga continua valendo',
    );
    assert.equal((await me(who)).statusCode, 200, 'e a sessão não foi revogada');
  });

  it('senha atual, senha nova, e-mail e tokens nunca aparecem em log, métrica nem corpo de erro', async () => {
    const who = await env.auth.userToken(env.client.id, { role: 'AGENT' });
    const errors = [
      await change(who, { currentPassword: SECRET_WRONG, newPassword: SECRET_NEW }),
      await change(who, { currentPassword: TEST_PASSWORD, newPassword: 'x' }),
      await change(undefined, { currentPassword: SECRET_WRONG, newPassword: SECRET_NEW }),
    ];
    for (let i = 0; i < 3; i += 1) {
      errors.push(await change(who, { currentPassword: SECRET_WRONG, newPassword: SECRET_NEW }));
    }
    const ok = await change(who, { currentPassword: TEST_PASSWORD, newPassword: SECRET_NEW });
    assert.ok([204, 429].includes(ok.statusCode));
    const everything = `${env.logs.raw()}\n${await env.metrics.render()}\n${errors.map((r) => r.body).join('\n')}`;
    for (const secret of [
      SECRET_NEW,
      SECRET_WRONG,
      TEST_PASSWORD,
      who.email,
      who.accessToken,
      who.refreshToken,
      'fake$',
    ]) {
      assert.ok(!everything.includes(secret), `vazou: ${secret.slice(0, 8)}`);
    }
  });
});
