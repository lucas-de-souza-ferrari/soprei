import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, describe, it } from 'node:test';
import { type Client, type UserId } from '../../domain/index.js';
import { createMetrics, type Metrics } from '../../infrastructure/metrics/index.js';
import { ServiceUnavailableError } from '../../shared/errors/index.js';
import {
  buildTestAuth,
  InMemorySessionStore,
  type TestAuth,
  TEST_PASSWORD,
} from '../../test-support/in-memory-auth.js';
import { captureLogs, type LogCapture } from '../../test-support/log-capture.js';
import { createHash, createHmac } from 'node:crypto';
import { deriveLoginLockSecret, parseRefreshToken } from './auth.service.js';

let clock = Date.UTC(2026, 5, 1, 12, 0, 0);
const now = (): Date => new Date(clock);

interface Env {
  auth: TestAuth;
  logs: LogCapture;
  metrics: Metrics;
  store: InMemorySessionStore;
  clientA: Client;
  clientB: Client;
}

async function setup(maxFailures = 3): Promise<Env> {
  clock = Date.UTC(2026, 5, 1, 12, 0, 0);
  const logs = captureLogs();
  const metrics = createMetrics();
  const store = new InMemorySessionStore({ maxFailures, lockSeconds: 900, now });
  const auth = buildTestAuth({
    logger: logs.logger,
    metrics,
    now,
    sessions: store,
    maxFailures,
  });
  const clientA = await auth.clients.create({ name: 'Cliente A', slug: 'cliente-a' });
  const clientB = await auth.clients.create({ name: 'Cliente B', slug: 'cliente-b' });
  return { auth, logs, metrics, store, clientA, clientB };
}

async function counter(metrics: Metrics, name: string, labels: string): Promise<number> {
  const text = await metrics.render();
  const match = new RegExp(`^${name}\\{${labels}\\} (\\d+)$`, 'm').exec(text);
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

const SECRET_EMAIL = 'pessoa-secreta@exemplo.test';

describe('AuthService.login', () => {
  let env: Env;
  beforeEach(async () => {
    env = await setup();
  });

  it('login válido de User e de PlatformAdmin devolve os dois tokens, tokenType e expiresIn', async () => {
    const { auth, clientA } = env;
    await auth.users.create(clientA.id, {
      email: SECRET_EMAIL,
      passwordHash: await auth.hasher.hash(TEST_PASSWORD),
    });
    const user = await auth.service.login({
      clientSlug: 'cliente-a',
      email: SECRET_EMAIL,
      password: TEST_PASSWORD,
    });
    assert.ok(user.ok);
    assert.equal(user.value.tokenType, 'Bearer');
    assert.equal(user.value.expiresIn, 900);
    assert.match(
      user.value.refreshToken,
      new RegExp(`^${clientA.id}\\.[0-9a-f-]{36}\\.[A-Za-z0-9_-]{64}$`),
    );
    const identity = await auth.service.authenticate(user.value.accessToken);
    assert.ok(identity.ok);
    assert.equal(identity.value.kind, 'user');

    const admin = await auth.platformToken('admin@exemplo.test');
    assert.match(admin.refreshToken, /^platform\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{64}$/);
    const platform = await auth.service.authenticate(admin.accessToken);
    assert.ok(platform.ok && platform.value.kind === 'platform');
  });

  it('o mesmo e-mail em dois clientes entra cada um no seu cliente, com o cid certo', async () => {
    const { auth, clientA, clientB } = env;
    for (const client of [clientA, clientB]) {
      await auth.users.create(client.id, {
        email: SECRET_EMAIL,
        passwordHash: await auth.hasher.hash(TEST_PASSWORD),
      });
    }
    for (const client of [clientA, clientB]) {
      const result = await auth.service.login({
        clientSlug: client.slug,
        email: SECRET_EMAIL,
        password: TEST_PASSWORD,
      });
      assert.ok(result.ok);
      const identity = await auth.service.authenticate(result.value.accessToken);
      assert.ok(identity.ok && identity.value.kind === 'user');
      assert.equal(identity.value.clientId, client.id);
    }
  });

  it('todas as recusas devolvem o mesmo erro e chamam o verify exatamente uma vez', async () => {
    const { auth, clientA, clientB } = env;
    const hash = await auth.hasher.hash(TEST_PASSWORD);
    await auth.users.create(clientA.id, { email: 'ativo@exemplo.test', passwordHash: hash });
    await auth.users.create(clientA.id, {
      email: 'desativado@exemplo.test',
      passwordHash: hash,
      status: 'DISABLED',
    });
    await auth.users.create(clientB.id, { email: 'ativo@exemplo.test', passwordHash: hash });
    await auth.clients.update(clientB.id, { status: 'SUSPENDED' });
    const removed = await auth.clients.create({ name: 'Removido', slug: 'cliente-removido' });
    await auth.users.create(removed.id, { email: 'ativo@exemplo.test', passwordHash: hash });
    await auth.clients.delete(removed.id);

    const attempts: readonly (readonly [string, string, string, string])[] = [
      ['slug inexistente', 'nao-existe', 'ativo@exemplo.test', TEST_PASSWORD],
      ['cliente removido', 'cliente-removido', 'ativo@exemplo.test', TEST_PASSWORD],
      ['cliente suspenso', 'cliente-b', 'ativo@exemplo.test', TEST_PASSWORD],
      ['e-mail inexistente', 'cliente-a', 'ninguem@exemplo.test', TEST_PASSWORD],
      ['usuário desativado', 'cliente-a', 'desativado@exemplo.test', TEST_PASSWORD],
      ['senha errada', 'cliente-a', 'ativo@exemplo.test', 'senha-errada-qualquer'],
    ];
    const outcomes: unknown[] = [];
    for (const [label, clientSlug, email, password] of attempts) {
      const before = auth.hasher.verifyCalls;
      // Cada tentativa com identidade própria no bloqueio (o teto de falhas é por conta).
      const result = await auth.service.login({ clientSlug, email, password });
      assert.equal(result.ok, false, label);
      assert.equal(auth.hasher.verifyCalls - before, 1, `${label}: verify uma vez`);
      outcomes.push(result);
    }
    for (const outcome of outcomes) assert.deepEqual(outcome, outcomes[0]);
    assert.deepEqual(outcomes[0], { ok: false, error: { reason: 'invalid_credentials' } });
  });

  it('bloqueio por conta: após o limite de falhas nem a senha certa entra, sem gastar hash', async () => {
    const { auth, clientA } = env;
    await auth.users.create(clientA.id, {
      email: SECRET_EMAIL,
      passwordHash: await auth.hasher.hash(TEST_PASSWORD),
    });
    const login = (password: string, email = SECRET_EMAIL) =>
      auth.service.login({ clientSlug: 'cliente-a', email, password });
    for (let i = 0; i < 3; i += 1) {
      assert.deepEqual(await login('senha-errada-1234'), {
        ok: false,
        error: { reason: 'invalid_credentials' },
      });
    }
    const before = auth.hasher.verifyCalls;
    const locked = await login(TEST_PASSWORD);
    assert.deepEqual(locked, { ok: false, error: { reason: 'locked', retryAfterSeconds: 900 } });
    assert.equal(auth.hasher.verifyCalls, before, 'bloqueada: nenhum hash');

    // Vale também para e-mail inexistente (sem enumeração).
    for (let i = 0; i < 3; i += 1) await login('x'.repeat(12), 'fantasma@exemplo.test');
    const ghost = await login('x'.repeat(12), 'fantasma@exemplo.test');
    assert.deepEqual(ghost, { ok: false, error: { reason: 'locked', retryAfterSeconds: 900 } });
    assert.equal(await counter(env.metrics, 'auth_logins_total', 'kind="user",result="locked"'), 2);
  });

  it('sucesso antes do limite zera o contador', async () => {
    const { auth, clientA } = env;
    await auth.users.create(clientA.id, {
      email: SECRET_EMAIL,
      passwordHash: await auth.hasher.hash(TEST_PASSWORD),
    });
    const login = (password: string) =>
      auth.service.login({ clientSlug: 'cliente-a', email: SECRET_EMAIL, password });
    for (let round = 0; round < 3; round += 1) {
      await login('errada-errada-1');
      await login('errada-errada-2');
      assert.ok((await login(TEST_PASSWORD)).ok, `rodada ${String(round)}`);
    }
  });

  it('o bloqueio de uma conta não afeta outra conta nem o mesmo e-mail em outro cliente', async () => {
    const { auth, clientA, clientB } = env;
    const hash = await auth.hasher.hash(TEST_PASSWORD);
    await auth.users.create(clientA.id, { email: SECRET_EMAIL, passwordHash: hash });
    await auth.users.create(clientB.id, { email: SECRET_EMAIL, passwordHash: hash });
    for (let i = 0; i < 3; i += 1) {
      await auth.service.login({
        clientSlug: 'cliente-a',
        email: SECRET_EMAIL,
        password: 'errada-errada-9',
      });
    }
    const a = await auth.service.login({
      clientSlug: 'cliente-a',
      email: SECRET_EMAIL,
      password: TEST_PASSWORD,
    });
    const b = await auth.service.login({
      clientSlug: 'cliente-b',
      email: SECRET_EMAIL,
      password: TEST_PASSWORD,
    });
    assert.equal(a.ok, false);
    assert.ok(b.ok);
  });

  it('login do administrador da plataforma: mesmas regras (recusa igual, uma verificação)', async () => {
    const { auth } = env;
    await auth.platformToken('admin@exemplo.test');
    const wrong = await auth.service.loginPlatform({
      email: 'admin@exemplo.test',
      password: 'errada-errada-1',
    });
    const ghost = await auth.service.loginPlatform({
      email: 'ninguem@exemplo.test',
      password: 'errada-errada-1',
    });
    assert.deepEqual(wrong, ghost);
    assert.deepEqual(wrong, { ok: false, error: { reason: 'invalid_credentials' } });
  });

  it('Redis (store) fora: unavailable, sem verificar senha nem emitir token', async () => {
    const { auth, store, clientA } = env;
    await auth.users.create(clientA.id, {
      email: SECRET_EMAIL,
      passwordHash: await auth.hasher.hash(TEST_PASSWORD),
    });
    store.failWith = new ServiceUnavailableError();
    const before = auth.hasher.verifyCalls;
    const result = await auth.service.login({
      clientSlug: 'cliente-a',
      email: SECRET_EMAIL,
      password: TEST_PASSWORD,
    });
    assert.deepEqual(result, { ok: false, error: { reason: 'unavailable' } });
    assert.equal(auth.hasher.verifyCalls, before);
    const platform = await auth.service.loginPlatform({
      email: 'a@b.test',
      password: TEST_PASSWORD,
    });
    assert.deepEqual(platform, { ok: false, error: { reason: 'unavailable' } });
  });

  it('métricas de login por kind e result, sem e-mail, slug nem id', async () => {
    const { auth, clientA, metrics } = env;
    await auth.users.create(clientA.id, {
      email: SECRET_EMAIL,
      passwordHash: await auth.hasher.hash(TEST_PASSWORD),
    });
    await auth.service.login({
      clientSlug: 'cliente-a',
      email: SECRET_EMAIL,
      password: TEST_PASSWORD,
    });
    await auth.service.login({
      clientSlug: 'cliente-a',
      email: SECRET_EMAIL,
      password: 'errada-errada-1',
    });
    assert.equal(await counter(metrics, 'auth_logins_total', 'kind="user",result="ok"'), 1);
    assert.equal(await counter(metrics, 'auth_logins_total', 'kind="user",result="invalid"'), 1);
    const text = await metrics.render();
    assert.ok(!text.includes(SECRET_EMAIL) && !text.includes('cliente-a'));
  });
});

describe('AuthService.refresh', () => {
  let env: Env;
  let userId: UserId;
  beforeEach(async () => {
    env = await setup();
  });

  async function login() {
    const issued = await env.auth.userToken(env.clientA.id, { role: 'AGENT' });
    userId = issued.userId as UserId;
    return issued;
  }

  it('devolve par novo e o refresh antigo deixa de funcionar (reuso derruba a sessão)', async () => {
    const first = await login();
    clock += 2_000;
    const second = await env.auth.service.refresh(first.refreshToken);
    assert.ok(second.ok);
    assert.notEqual(second.value.refreshToken, first.refreshToken);
    assert.notEqual(second.value.accessToken, first.accessToken);
    assert.equal(
      parseRefreshToken(second.value.refreshToken)?.sessionId,
      parseRefreshToken(first.refreshToken)?.sessionId,
    );

    // O antigo é reuso: 401 e a sessão inteira cai.
    const reuse = await env.auth.service.refresh(first.refreshToken);
    assert.deepEqual(reuse, { ok: false, error: { reason: 'reuse_detected' } });
    assert.equal(await counter(env.metrics, 'auth_refresh_total', 'result="reuse"'), 1);
    // O mais novo também falha e o access token da sessão é recusado (rsid).
    assert.deepEqual(await env.auth.service.refresh(second.value.refreshToken), {
      ok: false,
      error: { reason: 'invalid_refresh' },
    });
    assert.deepEqual(await env.auth.service.authenticate(second.value.accessToken), {
      ok: false,
      error: { reason: 'revoked' },
    });
    const warn = env.logs.lines().find((line) => line.msg?.toString().includes('reuso de refresh'));
    assert.ok(warn);
    assert.equal(warn.level, 40);
    assert.equal(warn.subjectId, userId);
  });

  it('segredo inventado com sessionId válido é 401 sem revogar a sessão', async () => {
    const issued = await login();
    const parsed = parseRefreshToken(issued.refreshToken);
    assert.ok(parsed);
    const invented = `${parsed.scope}.${parsed.sessionId}.${randomBytes(48).toString('base64url')}`;
    assert.deepEqual(await env.auth.service.refresh(invented), {
      ok: false,
      error: { reason: 'invalid_refresh' },
    });
    // A sessão legítima continua de pé.
    assert.ok((await env.auth.service.refresh(issued.refreshToken)).ok);
    assert.ok((await env.auth.service.authenticate(issued.accessToken)).ok);
  });

  it('escopo adulterado (ClientId de outro cliente) é 401 e não altera sessão alguma', async () => {
    const issued = await login();
    const other = await env.auth.userToken(env.clientB.id);
    const mine = parseRefreshToken(issued.refreshToken);
    const theirs = parseRefreshToken(other.refreshToken);
    assert.ok(mine && theirs);
    for (const forged of [
      `${env.clientB.id}.${mine.sessionId}.${mine.secret}`, // minha sessão, escopo do outro
      `${mine.scope}.${theirs.sessionId}.${theirs.secret}`, // sessão do outro, meu escopo
      `platform.${mine.sessionId}.${mine.secret}`,
    ]) {
      assert.deepEqual(await env.auth.service.refresh(forged), {
        ok: false,
        error: { reason: 'invalid_refresh' },
      });
    }
    // Nada foi rotacionado nem revogado: os dois refresh originais seguem válidos.
    assert.ok((await env.auth.service.refresh(issued.refreshToken)).ok);
    assert.ok((await env.auth.service.refresh(other.refreshToken)).ok);
  });

  it('refresh malformado é 401 sem tocar no store', async () => {
    for (const value of [
      '',
      'a.b.c',
      'lixo',
      `${env.clientA.id}.${randomUUID()}.curto`,
      '.'.repeat(300),
    ]) {
      assert.deepEqual(await env.auth.service.refresh(value), {
        ok: false,
        error: { reason: 'invalid_refresh' },
      });
    }
  });

  it('usuário desativado, cliente suspenso ou removido: o refresh falha e a sessão cai', async () => {
    const disabled = await login();
    await env.auth.users.update(env.clientA.id, disabled.userId, { status: 'DISABLED' });
    assert.deepEqual(await env.auth.service.refresh(disabled.refreshToken), {
      ok: false,
      error: { reason: 'invalid_refresh' },
    });
    assert.deepEqual(await env.auth.service.authenticate(disabled.accessToken), {
      ok: false,
      error: { reason: 'revoked' },
    });

    const suspendedUser = await env.auth.userToken(env.clientB.id);
    await env.auth.clients.update(env.clientB.id, { status: 'SUSPENDED' });
    assert.equal((await env.auth.service.refresh(suspendedUser.refreshToken)).ok, false);

    const clientC = await env.auth.clients.create({ name: 'C', slug: 'cliente-c' });
    const removedUser = await env.auth.userToken(clientC.id);
    await env.auth.clients.delete(clientC.id);
    assert.equal((await env.auth.service.refresh(removedUser.refreshToken)).ok, false);
  });

  it('o papel do novo access token é o atual do banco', async () => {
    const issued = await login();
    const before = await env.auth.service.authenticate(issued.accessToken);
    assert.ok(before.ok && before.value.kind === 'user');
    assert.equal(before.value.role, 'AGENT');
    await env.auth.users.update(env.clientA.id, issued.userId, { role: 'OWNER' });
    const refreshed = await env.auth.service.refresh(issued.refreshToken);
    assert.ok(refreshed.ok);
    const after = await env.auth.service.authenticate(refreshed.value.accessToken);
    assert.ok(after.ok && after.value.kind === 'user');
    assert.equal(after.value.role, 'OWNER');
  });

  it('administrador da plataforma: rotação e desativação', async () => {
    const admin = await env.auth.platformToken();
    const refreshed = await env.auth.service.refresh(admin.refreshToken);
    assert.ok(refreshed.ok);
    env.auth.platformAdmins.setStatus(admin.userId as never, 'DISABLED');
    assert.equal((await env.auth.service.refresh(refreshed.value.refreshToken)).ok, false);
  });

  it('store fora: unavailable e métrica unavailable', async () => {
    const issued = await login();
    env.store.failWith = new ServiceUnavailableError();
    assert.deepEqual(await env.auth.service.refresh(issued.refreshToken), {
      ok: false,
      error: { reason: 'unavailable' },
    });
    assert.equal(await counter(env.metrics, 'auth_refresh_total', 'result="unavailable"'), 1);
  });
});

describe('AuthService.logout, logout-all e authenticate', () => {
  let env: Env;
  beforeEach(async () => {
    env = await setup();
  });

  it('logout revoga a sessão (refresh e access falham), é idempotente e não afeta outras sessões', async () => {
    const { auth, clientA } = env;
    const first = await auth.userToken(clientA.id, { email: 'um@exemplo.test' });
    const login = await auth.service.login({
      clientSlug: 'cliente-a',
      email: 'um@exemplo.test',
      password: TEST_PASSWORD,
    });
    assert.ok(login.ok);

    assert.deepEqual(await auth.service.logout(first.refreshToken), { ok: true, value: undefined });
    assert.equal(await counter(env.metrics, 'auth_logouts_total', 'scope="session"'), 1);
    assert.equal((await auth.service.refresh(first.refreshToken)).ok, false);
    assert.deepEqual(await auth.service.authenticate(first.accessToken), {
      ok: false,
      error: { reason: 'revoked' },
    });
    // Idempotente, inclusive para refresh desconhecido ou malformado.
    assert.deepEqual(await auth.service.logout(first.refreshToken), { ok: true, value: undefined });
    assert.deepEqual(await auth.service.logout('lixo'), { ok: true, value: undefined });
    assert.deepEqual(
      await auth.service.logout(
        `${clientA.id}.${randomUUID()}.${randomBytes(48).toString('base64url')}`,
      ),
      { ok: true, value: undefined },
    );
    // A outra sessão do mesmo usuário segue válida.
    assert.ok((await auth.service.authenticate(login.value.accessToken)).ok);
    assert.ok((await auth.service.refresh(login.value.refreshToken)).ok);
  });

  it('logout com segredo inventado não revoga a sessão alheia', async () => {
    const issued = await env.auth.userToken(env.clientA.id);
    const parsed = parseRefreshToken(issued.refreshToken);
    assert.ok(parsed);
    await env.auth.service.logout(
      `${parsed.scope}.${parsed.sessionId}.${randomBytes(48).toString('base64url')}`,
    );
    assert.ok((await env.auth.service.authenticate(issued.accessToken)).ok);
  });

  it('logout-all revoga todas as sessões e todos os access tokens do usuário, sem afetar outros', async () => {
    const { auth, clientA, clientB } = env;
    const one = await auth.userToken(clientA.id, { email: 'um@exemplo.test' });
    clock += 2_000;
    const two = await auth.service.login({
      clientSlug: 'cliente-a',
      email: 'um@exemplo.test',
      password: TEST_PASSWORD,
    });
    assert.ok(two.ok);
    const otherUser = await auth.userToken(clientA.id);
    const otherClient = await auth.userToken(clientB.id, { email: 'um@exemplo.test' });

    clock += 2_000;
    const identity = await auth.service.authenticate(one.accessToken);
    assert.ok(identity.ok);
    assert.deepEqual(await auth.service.logoutAll(identity.value), { ok: true, value: undefined });

    for (const token of [one.accessToken, two.value.accessToken]) {
      assert.deepEqual(await auth.service.authenticate(token), {
        ok: false,
        error: { reason: 'revoked' },
      });
    }
    assert.equal((await auth.service.refresh(one.refreshToken)).ok, false);
    assert.equal((await auth.service.refresh(two.value.refreshToken)).ok, false);
    assert.ok((await auth.service.authenticate(otherUser.accessToken)).ok);
    assert.ok((await auth.service.authenticate(otherClient.accessToken)).ok);
    // Um login novo, depois do logout-all, volta a valer.
    clock += 2_000;
    const fresh = await auth.service.login({
      clientSlug: 'cliente-a',
      email: 'um@exemplo.test',
      password: TEST_PASSWORD,
    });
    assert.ok(fresh.ok);
    assert.ok((await auth.service.authenticate(fresh.value.accessToken)).ok);
    assert.equal(await counter(env.metrics, 'auth_logouts_total', 'scope="all"'), 1);
  });

  it('iat anterior ao nbf derruba o access token ainda dentro do prazo (mesmo sem rsid)', async () => {
    const { auth, store, clientA } = env;
    const issued = await auth.userToken(clientA.id);
    const verified = await auth.service.authenticate(issued.accessToken);
    assert.ok(verified.ok && verified.value.kind === 'user');
    clock += 3_000;
    // Só o `nbf`: outro sessionId no revokeAll não existe, então sobra apenas a regra do iat.
    await store.revokeAllSessions(verified.value.clientId, verified.value.userId);
    assert.deepEqual(await auth.service.authenticate(issued.accessToken), {
      ok: false,
      error: { reason: 'revoked' },
    });
  });

  it('authenticate com o store fora: unavailable (fail-closed)', async () => {
    const issued = await env.auth.userToken(env.clientA.id);
    env.store.failWith = new ServiceUnavailableError();
    assert.deepEqual(await env.auth.service.authenticate(issued.accessToken), {
      ok: false,
      error: { reason: 'unavailable' },
    });
    // Token já inválido nem consulta o store: a categoria é "invalid".
    assert.deepEqual(await env.auth.service.authenticate('a.b.c'), {
      ok: false,
      error: { reason: 'invalid' },
    });
  });

  it('GET /auth/me: identidade do banco, nunca o hash; token de conta removida é 401', async () => {
    const { auth, clientA } = env;
    const issued = await auth.userToken(clientA.id, { email: SECRET_EMAIL, role: 'OWNER' });
    const identity = await auth.service.authenticate(issued.accessToken);
    assert.ok(identity.ok);
    const me = await auth.service.me(identity.value);
    assert.deepEqual(me, {
      kind: 'user',
      id: issued.userId,
      email: SECRET_EMAIL,
      role: 'OWNER',
      client: { id: clientA.id, name: 'Cliente A', slug: 'cliente-a' },
    });
    assert.ok(!JSON.stringify(me).includes('hash'));
    await auth.users.delete(clientA.id, issued.userId);
    await assert.rejects(auth.service.me(identity.value), { code: 'UNAUTHORIZED' });
  });
});

describe('AuthService: privacidade dos logs', () => {
  it('login, recusa, bloqueio, refresh, reuso e logout não logam senha, e-mail, token nem hash', async () => {
    const env = await setup();
    const { auth, logs, clientA } = env;
    const email = 'segredo-nao-logar@exemplo.test';
    const password = 'senha-secreta-nunca-no-log-1';
    await auth.users.create(clientA.id, {
      email,
      passwordHash: await auth.hasher.hash(password),
    });
    const ok = await auth.service.login({ clientSlug: 'cliente-a', email, password });
    assert.ok(ok.ok);
    const refreshed = await auth.service.refresh(ok.value.refreshToken);
    assert.ok(refreshed.ok);
    await auth.service.refresh(ok.value.refreshToken); // reuso
    await auth.service.logout(refreshed.value.refreshToken);
    for (let i = 0; i < 4; i += 1) {
      await auth.service.login({
        clientSlug: 'cliente-a',
        email,
        password: 'outra-senha-errada-1',
      });
    }
    const raw = logs.raw();
    assert.ok(raw.length > 0);
    const secrets = [
      email,
      password,
      'outra-senha-errada-1',
      ok.value.accessToken,
      ok.value.refreshToken,
      refreshed.value.accessToken,
      refreshed.value.refreshToken,
      parseRefreshToken(ok.value.refreshToken)?.secret ?? 'x',
      await auth.hasher.hash(password),
      'cliente-a',
    ];
    for (const secret of secrets) assert.ok(!raw.includes(secret), `vazou: ${secret.slice(0, 12)}`);
  });
});

describe('AuthService: chave do contador de falhas de login', () => {
  it('é um HMAC com chave derivada do JWT_SECRET (não um SHA-256 simples de slug + e-mail)', async () => {
    const seen: string[] = [];
    class Spy extends InMemorySessionStore {
      override loginLockState(key: string) {
        seen.push(key);
        return super.loginLockState(key);
      }
    }
    const logs = captureLogs();
    const auth = buildTestAuth({ logger: logs.logger, sessions: new Spy() });
    await auth.clients.create({ name: 'A', slug: 'cliente-a' });
    await auth.service.login({
      clientSlug: 'cliente-a',
      email: SECRET_EMAIL,
      password: TEST_PASSWORD,
    });
    await auth.service.loginPlatform({ email: SECRET_EMAIL, password: TEST_PASSWORD });
    assert.equal(seen.length, 2);

    const plain = createHash('sha256')
      .update(['c', 'cliente-a', SECRET_EMAIL].join(' '))
      .digest('hex');
    const secret = deriveLoginLockSecret('segredo-de-teste-com-mais-de-32-caracteres-0123456789');
    const expected = createHmac('sha256', secret)
      .update(['c', 'cliente-a', SECRET_EMAIL].join(' '))
      .digest('hex');
    assert.match(seen[0] ?? '', /^[0-9a-f]{64}$/);
    assert.notEqual(seen[0], plain, 'não é o SHA-256 simples');
    assert.equal(seen[0], expected);
    // Outro segredo de JWT produz outra chave (a chave depende do segredo); plataforma != cliente.
    const other = createHmac(
      'sha256',
      deriveLoginLockSecret('outro-segredo-completamente-diferente-0000'),
    )
      .update(['c', 'cliente-a', SECRET_EMAIL].join(' '))
      .digest('hex');
    assert.notEqual(other, expected);
    assert.notEqual(seen[1], seen[0]);
    assert.notEqual(deriveLoginLockSecret('a'.repeat(32)).toString('hex'), 'a'.repeat(32));
  });
});
