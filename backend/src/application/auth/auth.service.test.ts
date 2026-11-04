import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, describe, it } from 'node:test';
import { type Company, type MembershipId } from '../../domain/index.js';
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
  companyA: Company;
  companyB: Company;
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
  const companyA = await auth.companies.create({ name: 'Empresa A', slug: 'empresa-a' });
  const companyB = await auth.companies.create({ name: 'Empresa B', slug: 'empresa-b' });
  return { auth, logs, metrics, store, companyA, companyB };
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

  it('login válido de Membership e de PlatformAdmin devolve os dois tokens, tokenType e expiresIn', async () => {
    const { auth, companyA } = env;
    await auth.memberships.create(companyA.id, {
      email: SECRET_EMAIL,
      passwordHash: await auth.hasher.hash(TEST_PASSWORD),
    });
    const membership = await auth.service.login({
      companySlug: 'empresa-a',
      email: SECRET_EMAIL,
      password: TEST_PASSWORD,
    });
    assert.ok(membership.ok);
    assert.equal(membership.value.tokenType, 'Bearer');
    assert.equal(membership.value.expiresIn, 900);
    assert.match(
      membership.value.refreshToken,
      new RegExp(`^${companyA.id}\\.[0-9a-f-]{36}\\.[A-Za-z0-9_-]{64}$`),
    );
    const identity = await auth.service.authenticate(membership.value.accessToken);
    assert.ok(identity.ok);
    assert.equal(identity.value.kind, 'membership');

    const admin = await auth.platformToken('admin@exemplo.test');
    assert.match(admin.refreshToken, /^platform\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{64}$/);
    const platform = await auth.service.authenticate(admin.accessToken);
    assert.ok(platform.ok && platform.value.kind === 'platform');
  });

  it('o mesmo e-mail em duas empresas entra cada uma na sua empresa, com o cid certo', async () => {
    const { auth, companyA, companyB } = env;
    for (const company of [companyA, companyB]) {
      await auth.memberships.create(company.id, {
        email: SECRET_EMAIL,
        passwordHash: await auth.hasher.hash(TEST_PASSWORD),
      });
    }
    for (const company of [companyA, companyB]) {
      const result = await auth.service.login({
        companySlug: company.slug,
        email: SECRET_EMAIL,
        password: TEST_PASSWORD,
      });
      assert.ok(result.ok);
      const identity = await auth.service.authenticate(result.value.accessToken);
      assert.ok(identity.ok && identity.value.kind === 'membership');
      assert.equal(identity.value.companyId, company.id);
    }
  });

  it('todas as recusas devolvem o mesmo erro e chamam o verify exatamente uma vez', async () => {
    const { auth, companyA, companyB } = env;
    const hash = await auth.hasher.hash(TEST_PASSWORD);
    await auth.memberships.create(companyA.id, { email: 'ativo@exemplo.test', passwordHash: hash });
    await auth.memberships.create(companyA.id, {
      email: 'desativado@exemplo.test',
      passwordHash: hash,
      status: 'DISABLED',
    });
    await auth.memberships.create(companyB.id, { email: 'ativo@exemplo.test', passwordHash: hash });
    await auth.companies.update(companyB.id, { status: 'SUSPENDED' });
    const removed = await auth.companies.create({ name: 'Removido', slug: 'empresa-removido' });
    await auth.memberships.create(removed.id, { email: 'ativo@exemplo.test', passwordHash: hash });
    await auth.companies.delete(removed.id);

    const attempts: readonly (readonly [string, string, string, string])[] = [
      ['slug inexistente', 'nao-existe', 'ativo@exemplo.test', TEST_PASSWORD],
      ['empresa removida', 'empresa-removido', 'ativo@exemplo.test', TEST_PASSWORD],
      ['empresa suspensa', 'empresa-b', 'ativo@exemplo.test', TEST_PASSWORD],
      ['e-mail inexistente', 'empresa-a', 'ninguem@exemplo.test', TEST_PASSWORD],
      ['usuário desativado', 'empresa-a', 'desativado@exemplo.test', TEST_PASSWORD],
      ['senha errada', 'empresa-a', 'ativo@exemplo.test', 'senha-errada-qualquer'],
    ];
    const outcomes: unknown[] = [];
    for (const [label, companySlug, email, password] of attempts) {
      const before = auth.hasher.verifyCalls;
      // Cada tentativa com identidade própria no bloqueio (o teto de falhas é por conta).
      const result = await auth.service.login({ companySlug, email, password });
      assert.equal(result.ok, false, label);
      assert.equal(auth.hasher.verifyCalls - before, 1, `${label}: verify uma vez`);
      outcomes.push(result);
    }
    for (const outcome of outcomes) assert.deepEqual(outcome, outcomes[0]);
    assert.deepEqual(outcomes[0], { ok: false, error: { reason: 'invalid_credentials' } });
  });

  it('bloqueio por conta: após o limite de falhas nem a senha certa entra, sem gastar hash', async () => {
    const { auth, companyA } = env;
    await auth.memberships.create(companyA.id, {
      email: SECRET_EMAIL,
      passwordHash: await auth.hasher.hash(TEST_PASSWORD),
    });
    const login = (password: string, email = SECRET_EMAIL) =>
      auth.service.login({ companySlug: 'empresa-a', email, password });
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
    assert.equal(
      await counter(env.metrics, 'auth_logins_total', 'kind="membership",result="locked"'),
      2,
    );
  });

  it('sucesso antes do limite zera o contador', async () => {
    const { auth, companyA } = env;
    await auth.memberships.create(companyA.id, {
      email: SECRET_EMAIL,
      passwordHash: await auth.hasher.hash(TEST_PASSWORD),
    });
    const login = (password: string) =>
      auth.service.login({ companySlug: 'empresa-a', email: SECRET_EMAIL, password });
    for (let round = 0; round < 3; round += 1) {
      await login('errada-errada-1');
      await login('errada-errada-2');
      assert.ok((await login(TEST_PASSWORD)).ok, `rodada ${String(round)}`);
    }
  });

  it('o bloqueio de uma conta não afeta outra conta nem o mesmo e-mail em outra empresa', async () => {
    const { auth, companyA, companyB } = env;
    const hash = await auth.hasher.hash(TEST_PASSWORD);
    await auth.memberships.create(companyA.id, { email: SECRET_EMAIL, passwordHash: hash });
    await auth.memberships.create(companyB.id, { email: SECRET_EMAIL, passwordHash: hash });
    for (let i = 0; i < 3; i += 1) {
      await auth.service.login({
        companySlug: 'empresa-a',
        email: SECRET_EMAIL,
        password: 'errada-errada-9',
      });
    }
    const a = await auth.service.login({
      companySlug: 'empresa-a',
      email: SECRET_EMAIL,
      password: TEST_PASSWORD,
    });
    const b = await auth.service.login({
      companySlug: 'empresa-b',
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
    const { auth, store, companyA } = env;
    await auth.memberships.create(companyA.id, {
      email: SECRET_EMAIL,
      passwordHash: await auth.hasher.hash(TEST_PASSWORD),
    });
    store.failWith = new ServiceUnavailableError();
    const before = auth.hasher.verifyCalls;
    const result = await auth.service.login({
      companySlug: 'empresa-a',
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
    const { auth, companyA, metrics } = env;
    await auth.memberships.create(companyA.id, {
      email: SECRET_EMAIL,
      passwordHash: await auth.hasher.hash(TEST_PASSWORD),
    });
    await auth.service.login({
      companySlug: 'empresa-a',
      email: SECRET_EMAIL,
      password: TEST_PASSWORD,
    });
    await auth.service.login({
      companySlug: 'empresa-a',
      email: SECRET_EMAIL,
      password: 'errada-errada-1',
    });
    assert.equal(await counter(metrics, 'auth_logins_total', 'kind="membership",result="ok"'), 1);
    assert.equal(
      await counter(metrics, 'auth_logins_total', 'kind="membership",result="invalid"'),
      1,
    );
    const text = await metrics.render();
    assert.ok(!text.includes(SECRET_EMAIL) && !text.includes('empresa-a'));
  });
});

describe('AuthService.refresh', () => {
  let env: Env;
  let membershipId: MembershipId;
  beforeEach(async () => {
    env = await setup();
  });

  async function login() {
    const issued = await env.auth.membershipToken(env.companyA.id, { role: 'AGENT' });
    membershipId = issued.membershipId as MembershipId;
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
    assert.equal(warn.subjectId, membershipId);
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

  it('escopo adulterado (CompanyId de outra empresa) é 401 e não altera sessão alguma', async () => {
    const issued = await login();
    const other = await env.auth.membershipToken(env.companyB.id);
    const mine = parseRefreshToken(issued.refreshToken);
    const theirs = parseRefreshToken(other.refreshToken);
    assert.ok(mine && theirs);
    for (const forged of [
      `${env.companyB.id}.${mine.sessionId}.${mine.secret}`, // minha sessão, escopo do outro
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
      `${env.companyA.id}.${randomUUID()}.curto`,
      '.'.repeat(300),
    ]) {
      assert.deepEqual(await env.auth.service.refresh(value), {
        ok: false,
        error: { reason: 'invalid_refresh' },
      });
    }
  });

  it('usuário desativado, empresa suspensa ou removido: o refresh falha e a sessão cai', async () => {
    const disabled = await login();
    await env.auth.memberships.update(env.companyA.id, disabled.membershipId, {
      status: 'DISABLED',
    });
    assert.deepEqual(await env.auth.service.refresh(disabled.refreshToken), {
      ok: false,
      error: { reason: 'invalid_refresh' },
    });
    assert.deepEqual(await env.auth.service.authenticate(disabled.accessToken), {
      ok: false,
      error: { reason: 'revoked' },
    });

    const suspendedMembership = await env.auth.membershipToken(env.companyB.id);
    await env.auth.companies.update(env.companyB.id, { status: 'SUSPENDED' });
    assert.equal((await env.auth.service.refresh(suspendedMembership.refreshToken)).ok, false);

    const companyC = await env.auth.companies.create({ name: 'C', slug: 'empresa-c' });
    const removedMembership = await env.auth.membershipToken(companyC.id);
    await env.auth.companies.delete(companyC.id);
    assert.equal((await env.auth.service.refresh(removedMembership.refreshToken)).ok, false);
  });

  it('o papel do novo access token é o atual do banco', async () => {
    const issued = await login();
    const before = await env.auth.service.authenticate(issued.accessToken);
    assert.ok(before.ok && before.value.kind === 'membership');
    assert.equal(before.value.role, 'AGENT');
    await env.auth.memberships.update(env.companyA.id, issued.membershipId, { role: 'OWNER' });
    const refreshed = await env.auth.service.refresh(issued.refreshToken);
    assert.ok(refreshed.ok);
    const after = await env.auth.service.authenticate(refreshed.value.accessToken);
    assert.ok(after.ok && after.value.kind === 'membership');
    assert.equal(after.value.role, 'OWNER');
  });

  it('administrador da plataforma: rotação e desativação', async () => {
    const admin = await env.auth.platformToken();
    const refreshed = await env.auth.service.refresh(admin.refreshToken);
    assert.ok(refreshed.ok);
    env.auth.platformAdmins.setStatus(admin.membershipId as never, 'DISABLED');
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
    const { auth, companyA } = env;
    const first = await auth.membershipToken(companyA.id, { email: 'um@exemplo.test' });
    const login = await auth.service.login({
      companySlug: 'empresa-a',
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
        `${companyA.id}.${randomUUID()}.${randomBytes(48).toString('base64url')}`,
      ),
      { ok: true, value: undefined },
    );
    // A outra sessão do mesmo usuário segue válida.
    assert.ok((await auth.service.authenticate(login.value.accessToken)).ok);
    assert.ok((await auth.service.refresh(login.value.refreshToken)).ok);
  });

  it('logout com segredo inventado não revoga a sessão alheia', async () => {
    const issued = await env.auth.membershipToken(env.companyA.id);
    const parsed = parseRefreshToken(issued.refreshToken);
    assert.ok(parsed);
    await env.auth.service.logout(
      `${parsed.scope}.${parsed.sessionId}.${randomBytes(48).toString('base64url')}`,
    );
    assert.ok((await env.auth.service.authenticate(issued.accessToken)).ok);
  });

  it('logout-all revoga todas as sessões e todos os access tokens do usuário, sem afetar outros', async () => {
    const { auth, companyA, companyB } = env;
    const one = await auth.membershipToken(companyA.id, { email: 'um@exemplo.test' });
    clock += 2_000;
    const two = await auth.service.login({
      companySlug: 'empresa-a',
      email: 'um@exemplo.test',
      password: TEST_PASSWORD,
    });
    assert.ok(two.ok);
    const otherMembership = await auth.membershipToken(companyA.id);
    const otherCompany = await auth.membershipToken(companyB.id, { email: 'um@exemplo.test' });

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
    assert.ok((await auth.service.authenticate(otherMembership.accessToken)).ok);
    assert.ok((await auth.service.authenticate(otherCompany.accessToken)).ok);
    // Um login novo, depois do logout-all, volta a valer.
    clock += 2_000;
    const fresh = await auth.service.login({
      companySlug: 'empresa-a',
      email: 'um@exemplo.test',
      password: TEST_PASSWORD,
    });
    assert.ok(fresh.ok);
    assert.ok((await auth.service.authenticate(fresh.value.accessToken)).ok);
    assert.equal(await counter(env.metrics, 'auth_logouts_total', 'scope="all"'), 1);
  });

  it('iat anterior ao nbf derruba o access token ainda dentro do prazo (mesmo sem rsid)', async () => {
    const { auth, store, companyA } = env;
    const issued = await auth.membershipToken(companyA.id);
    const verified = await auth.service.authenticate(issued.accessToken);
    assert.ok(verified.ok && verified.value.kind === 'membership');
    clock += 3_000;
    // Só o `nbf`: outro sessionId no revokeAll não existe, então sobra apenas a regra do iat.
    await store.revokeAllSessions(verified.value.companyId, verified.value.membershipId);
    assert.deepEqual(await auth.service.authenticate(issued.accessToken), {
      ok: false,
      error: { reason: 'revoked' },
    });
  });

  it('authenticate com o store fora: unavailable (fail-closed)', async () => {
    const issued = await env.auth.membershipToken(env.companyA.id);
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
    const { auth, companyA } = env;
    const issued = await auth.membershipToken(companyA.id, { email: SECRET_EMAIL, role: 'OWNER' });
    const identity = await auth.service.authenticate(issued.accessToken);
    assert.ok(identity.ok);
    const me = await auth.service.me(identity.value);
    assert.deepEqual(me, {
      kind: 'membership',
      id: issued.membershipId,
      email: SECRET_EMAIL,
      role: 'OWNER',
      company: { id: companyA.id, name: 'Empresa A', slug: 'empresa-a' },
    });
    assert.ok(!JSON.stringify(me).includes('hash'));
    await auth.memberships.delete(companyA.id, issued.membershipId);
    await assert.rejects(auth.service.me(identity.value), { code: 'UNAUTHORIZED' });
  });
});

describe('AuthService: privacidade dos logs', () => {
  it('login, recusa, bloqueio, refresh, reuso e logout não logam senha, e-mail, token nem hash', async () => {
    const env = await setup();
    const { auth, logs, companyA } = env;
    const email = 'segredo-nao-logar@exemplo.test';
    const password = 'senha-secreta-nunca-no-log-1';
    await auth.memberships.create(companyA.id, {
      email,
      passwordHash: await auth.hasher.hash(password),
    });
    const ok = await auth.service.login({ companySlug: 'empresa-a', email, password });
    assert.ok(ok.ok);
    const refreshed = await auth.service.refresh(ok.value.refreshToken);
    assert.ok(refreshed.ok);
    await auth.service.refresh(ok.value.refreshToken); // reuso
    await auth.service.logout(refreshed.value.refreshToken);
    for (let i = 0; i < 4; i += 1) {
      await auth.service.login({
        companySlug: 'empresa-a',
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
      'empresa-a',
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
    await auth.companies.create({ name: 'A', slug: 'empresa-a' });
    await auth.service.login({
      companySlug: 'empresa-a',
      email: SECRET_EMAIL,
      password: TEST_PASSWORD,
    });
    await auth.service.loginPlatform({ email: SECRET_EMAIL, password: TEST_PASSWORD });
    assert.equal(seen.length, 2);

    const plain = createHash('sha256')
      .update(['c', 'empresa-a', SECRET_EMAIL].join(' '))
      .digest('hex');
    const secret = deriveLoginLockSecret('segredo-de-teste-com-mais-de-32-caracteres-0123456789');
    const expected = createHmac('sha256', secret)
      .update(['c', 'empresa-a', SECRET_EMAIL].join(' '))
      .digest('hex');
    assert.match(seen[0] ?? '', /^[0-9a-f]{64}$/);
    assert.notEqual(seen[0], plain, 'não é o SHA-256 simples');
    assert.equal(seen[0], expected);
    // Outro segredo de JWT produz outra chave (a chave depende do segredo); plataforma != empresa.
    const other = createHmac(
      'sha256',
      deriveLoginLockSecret('outro-segredo-completamente-diferente-0000'),
    )
      .update(['c', 'empresa-a', SECRET_EMAIL].join(' '))
      .digest('hex');
    assert.notEqual(other, expected);
    assert.notEqual(seen[1], seen[0]);
    assert.notEqual(deriveLoginLockSecret('a'.repeat(32)).toString('hex'), 'a'.repeat(32));
  });
});

describe('AuthService.login com a fila do hasher cheia (spec 008)', () => {
  it('ServiceUnavailableError do hasher vira "unavailable" (503) e não conta como falha de senha', async () => {
    const env = await setup(2);
    const { auth, companyA } = env;
    await auth.memberships.create(companyA.id, {
      email: SECRET_EMAIL,
      passwordHash: await auth.hasher.hash(TEST_PASSWORD),
    });
    const verify = auth.hasher.verify.bind(auth.hasher);
    auth.hasher.verify = () => Promise.reject(new ServiceUnavailableError());
    for (let i = 0; i < 5; i += 1) {
      const result = await auth.service.login({
        companySlug: 'empresa-a',
        email: SECRET_EMAIL,
        password: TEST_PASSWORD,
      });
      assert.ok(!result.ok);
      assert.equal(result.error.reason, 'unavailable');
    }
    auth.hasher.verify = verify;
    // Nada foi contado como falha: o login certo ainda passa (o limite de 2 não foi atingido).
    const ok = await auth.service.login({
      companySlug: 'empresa-a',
      email: SECRET_EMAIL,
      password: TEST_PASSWORD,
    });
    assert.ok(ok.ok);
  });
});
