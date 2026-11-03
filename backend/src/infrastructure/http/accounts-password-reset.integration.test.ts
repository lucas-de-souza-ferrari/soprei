import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccountService } from '../../application/auth/account.service.js';
import type { AccountSessionStore } from '../../application/ports/account-session.js';
import { ServiceUnavailableError } from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { captureLogs, logContains } from '../../test-support/log-capture.js';
import { TestKeyspace } from '../../test-support/test-keyspace.js';
import { createRedis } from '../cache/redis.client.js';
import { createDatabase, PrismaAccountRepository } from '../database/index.js';
import { createAuthRedis } from '../auth/auth-redis.js';
import { createAuthComponents } from '../auth/create-auth.js';
import { ScryptPasswordHasher } from '../auth/scrypt-password-hasher.js';
import { RedisAccountSessionStore } from '../auth/redis-account-session-store.js';
import { createMetrics } from '../metrics/index.js';
import { buildServer } from './server.js';

const config = loadIntegrationConfig();
const origin = 'http://localhost:5174';
const headers = { origin, 'x-soprei-client': 'web' };

test('recuperação de senha de ponta a ponta: sessões revogadas, uniformidade, 503 do Redis, métricas e log sem segredo', async () => {
  const logs = captureLogs();
  const db = createDatabase(config, logs.logger);
  const keys = new TestKeyspace();
  const prefix = keys.scopedPrefix('accounts-reset');
  const redis = createAuthRedis(config, logs.logger);
  const main = createRedis(config, logs.logger);
  assert.ok(await redis.waitUntilReady(5000));
  const passwords = new ScryptPasswordHasher({ cost: { N: 1024, r: 8, p: 1 } });
  const auth = createAuthComponents({
    config: { ...config, ACCOUNTS_ENABLED: true, AUTH_REDIS_PREFIX: prefix },
    logger: logs.logger,
    prisma: db.prisma,
    authRedis: redis,
    hasher: passwords,
  });
  const metrics = createMetrics();
  const store = new RedisAccountSessionStore(redis.client, prefix);
  // Falha sob comando: a n-ésima chamada de `revokeAll` (contando a partir do armamento) cai.
  const fault = { failOnCall: 0, calls: 0 };
  const sessions: AccountSessionStore = {
    create: (id) => store.create(id),
    read: (secret) => store.read(secret),
    select: (secret, clientId) => store.select(secret, clientId),
    revoke: (secret) => store.revoke(secret),
    revokeAll: (id) => {
      fault.calls += 1;
      if (fault.calls === fault.failOnCall)
        return Promise.reject(new ServiceUnavailableError('Sessão indisponível'));
      return store.revokeAll(id);
    },
  };
  let clock = Date.now();
  const verificationMail = new Map<string, string>();
  const resetMail: string[] = [];
  const resetCodes = new Map<string, string>();
  const notices: string[] = [];
  let counter = 400_000;
  const service = new AccountService({
    accounts: new PrismaAccountRepository(db.prisma),
    passwords,
    sessions,
    loginLocks: auth.sessions,
    loginSecret: config.JWT_SECRET,
    now: () => new Date(clock),
    randomInt: () => counter++,
    // Como em src/index.ts: só resultados e ids.
    onPasswordResetRequest: (result) => {
      metrics.countPasswordResetRequest(result);
    },
    onPasswordReset: (result, accountId) => {
      metrics.countPasswordResetAttempt(result);
      logs.logger.info({ accountId, result }, 'tentativa de redefinição');
    },
    onPasswordResetMail: (kind, result, accountId) => {
      metrics.countPasswordResetEmail(kind, result);
      logs.logger.info({ accountId, kind, result }, 'e-mail da recuperação');
    },
    mailer: {
      sendVerification: (email, code) => {
        verificationMail.set(email, code);
        return Promise.resolve();
      },
      sendPasswordReset: (email, code) => {
        resetMail.push(email);
        resetCodes.set(email, code);
        return Promise.resolve();
      },
      sendPasswordChanged: (email) => {
        notices.push(email);
        return Promise.resolve();
      },
    },
  });
  const app = buildServer({
    logger: logs.logger,
    readiness: { database: () => db.check(), redis: () => Promise.resolve(Result.ok(undefined)) },
    auth: auth.service,
    accounts: { service, origin, secure: false },
  });
  const post = (url: string, payload: object) =>
    app.inject({ method: 'POST', url, payload, headers });
  const emailA = `reset-a-${randomUUID()}@example.test`;
  const emailB = `reset-b-${randomUUID()}@example.test`;
  const oldPassword = `Dono1-${randomUUID()}`;
  const newPassword = `Nova1-${randomUUID()}`;
  const thirdPassword = `Terc1-${randomUUID()}`;
  const fourthPassword = `Quar1-${randomUUID()}`;
  const row = (email: string) => db.prisma.account.findUnique({ where: { email } });
  // O requestId muda a cada resposta: compara só o que precisa ser uniforme.
  const errorOf = (response: Awaited<ReturnType<typeof post>>) => {
    const { code, message } = response.json<{ error: { code: string; message: string } }>().error;
    return { code, message };
  };
  const confirmedAccount = async (email: string): Promise<string> => {
    assert.equal((await post('/auth/register', { email, password: oldPassword })).statusCode, 202);
    await service.drain();
    assert.equal(
      (
        await post('/auth/verify-email', {
          email,
          password: oldPassword,
          code: verificationMail.get(email),
        })
      ).statusCode,
      204,
    );
    const login = await post('/auth/login', { email, password: oldPassword });
    assert.equal(login.statusCode, 204);
    return String(login.headers['set-cookie']).split(';')[0] ?? '';
  };
  const sessionStatus = async (cookie: string): Promise<number> =>
    (await app.inject({ url: '/auth/session', headers: { cookie } })).statusCode;
  const request = async (email: string): Promise<string> => {
    const before = resetMail.length;
    const response = await post('/auth/password-reset/request', { email });
    assert.equal(response.statusCode, 202);
    await service.drain();
    assert.equal(resetMail.length, before + 1);
    return resetCodes.get(email) ?? '';
  };
  try {
    const cookieA = await confirmedAccount(emailA);
    const cookieB = await confirmedAccount(emailB);
    const cookieA2 =
      String(
        (await post('/auth/login', { email: emailA, password: oldPassword })).headers['set-cookie'],
      ).split(';')[0] ?? '';
    assert.equal(await sessionStatus(cookieA), 200);
    assert.equal(await sessionStatus(cookieA2), 200);
    assert.equal(await sessionStatus(cookieB), 200);

    // Pedido: a mesma resposta para conta existente e inexistente; só a existente recebe e-mail.
    const ghost = await post('/auth/password-reset/request', {
      email: `ninguem-${randomUUID()}@example.test`,
    });
    const code = await request(emailA);
    assert.match(code, /^\d{6}$/);
    const known = await post('/auth/password-reset/request', { email: emailA });
    assert.equal(ghost.statusCode, 202);
    assert.equal(known.statusCode, 202);
    assert.deepEqual(ghost.json(), known.json());
    await service.drain();
    assert.equal(resetMail.length, 1, 'o segundo pedido (menos de 60 s) não envia');
    const stored = (await row(emailA))?.resetHash;
    assert.ok(stored);
    assert.match(stored, /^[0-9a-f]{64}$/);
    assert.notEqual(stored, code);

    // Formato inválido: 400, sem contar tentativa.
    for (const payload of [
      { email: emailA, code: '12345', newPassword },
      { email: emailA, code: '1234567', newPassword },
      { email: emailA, code: '12345a', newPassword },
      { email: emailA, code: code, newPassword: 'curta' },
      { email: emailA, code: code, newPassword, extra: true },
      { email: emailA, token: code, newPassword },
    ]) {
      assert.equal((await post('/auth/password-reset/confirm', payload)).statusCode, 400);
    }
    assert.equal((await row(emailA))?.resetAttempts, 0);

    // Erros: a mesma 401 para código errado, conta inexistente e conta não confirmada.
    const wrong = await post('/auth/password-reset/confirm', {
      email: emailA,
      code: '000001',
      newPassword,
    });
    const missing = await post('/auth/password-reset/confirm', {
      email: `ninguem-${randomUUID()}@example.test`,
      code: '000001',
      newPassword,
    });
    assert.equal(wrong.statusCode, 401);
    assert.equal(missing.statusCode, 401);
    assert.deepEqual(errorOf(wrong), errorOf(missing));
    assert.deepEqual(errorOf(wrong), {
      code: 'UNAUTHORIZED',
      message: 'Código inválido ou expirado',
    });
    assert.equal((await row(emailA))?.resetAttempts, 1);

    // Código certo: 204, sem cookie e sem login automático; todas as sessões de A caem; B segue.
    const done = await post('/auth/password-reset/confirm', { email: emailA, code, newPassword });
    assert.equal(done.statusCode, 204);
    assert.equal(done.headers['set-cookie'], undefined);
    assert.equal(await sessionStatus(cookieA), 401);
    assert.equal(await sessionStatus(cookieA2), 401);
    assert.equal(await sessionStatus(cookieB), 200);
    const reset = await row(emailA);
    assert.equal(reset?.resetHash, null);
    assert.equal(reset.resetFailuresDay, 0);
    await service.drain();
    assert.deepEqual(notices, [emailA]);
    // Senha antiga recusada, nova aceita; sessão criada depois do reset vale.
    assert.equal(
      (await post('/auth/login', { email: emailA, password: oldPassword })).statusCode,
      401,
    );
    const relogin = await post('/auth/login', { email: emailA, password: newPassword });
    assert.equal(relogin.statusCode, 204);
    assert.equal(
      await sessionStatus(String(relogin.headers['set-cookie']).split(';')[0] ?? ''),
      200,
    );
    // O código usado não vale de novo.
    const reused = await post('/auth/password-reset/confirm', {
      email: emailA,
      code,
      newPassword: thirdPassword,
    });
    assert.equal(reused.statusCode, 401);
    assert.deepEqual(errorOf(reused), errorOf(wrong));

    // Redis fora ANTES do commit: 503 e nada muda; repetir funciona.
    clock += 61_000;
    const second = await request(emailA);
    const hashBefore = (await row(emailA))?.passwordHash;
    fault.calls = 0;
    fault.failOnCall = 1;
    const down = await post('/auth/password-reset/confirm', {
      email: emailA,
      code: second,
      newPassword: thirdPassword,
    });
    assert.equal(down.statusCode, 503);
    assert.equal((await row(emailA))?.passwordHash, hashBefore);
    assert.ok((await row(emailA))?.resetHash);
    fault.failOnCall = 0;
    assert.equal(
      (
        await post('/auth/password-reset/confirm', {
          email: emailA,
          code: second,
          newPassword: thirdPassword,
        })
      ).statusCode,
      204,
    );

    // Redis fora DEPOIS do commit: 503 com a senha já trocada e o código gasto.
    clock += 61_000;
    const third = await request(emailA);
    fault.calls = 0;
    fault.failOnCall = 2;
    const late = await post('/auth/password-reset/confirm', {
      email: emailA,
      code: third,
      newPassword: fourthPassword,
    });
    assert.equal(late.statusCode, 503);
    fault.failOnCall = 0;
    assert.equal(
      (await post('/auth/login', { email: emailA, password: fourthPassword })).statusCode,
      204,
    );
    assert.equal(
      (
        await post('/auth/password-reset/confirm', {
          email: emailA,
          code: third,
          newPassword: newPassword,
        })
      ).statusCode,
      401,
    );

    // Métricas: labels fixos, sem id, e-mail, IP nem código.
    const body = await metrics.render();
    for (const line of [
      'account_password_reset_requests_total{result="issued"} 3',
      'account_password_reset_requests_total{result="ignored"} 2',
      'account_password_reset_attempts_total{result="reset"} 3',
      'account_password_reset_attempts_total{result="revoke_failed"} 2',
      'account_password_reset_emails_total{kind="code",result="sent"} 3',
    ]) {
      assert.ok(body.includes(line), line);
    }
    for (const secret of [emailA, newPassword, code, second, third, stored]) {
      assert.ok(!body.includes(secret));
    }

    // Log do fluxo todo: sem código, hash, e-mail, senha nem cookie.
    const raw = logs.raw();
    for (const secret of [
      code,
      second,
      third,
      stored,
      emailA,
      emailB,
      oldPassword,
      newPassword,
      thirdPassword,
      fourthPassword,
      cookieA.split('=')[1] ?? cookieA,
    ]) {
      assert.ok(!logContains(raw, secret), 'segredo no log');
    }
  } finally {
    await app.close();
    await db.prisma.account.deleteMany({ where: { email: { in: [emailA, emailB] } } });
    await keys.cleanup(redis.client);
    await redis.close();
    await main.close();
    await db.close();
  }
});
