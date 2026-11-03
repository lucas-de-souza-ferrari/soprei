import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccountService } from '../../application/auth/account.service.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { captureLogs, logContains } from '../../test-support/log-capture.js';
import { TestKeyspace } from '../../test-support/test-keyspace.js';
import { Result } from '../../shared/types/index.js';
import { createDatabase, PrismaAccountRepository } from '../database/index.js';
import { createAuthRedis } from '../auth/auth-redis.js';
import { createAuthComponents } from '../auth/create-auth.js';
import { ScryptPasswordHasher } from '../auth/scrypt-password-hasher.js';
import { RedisAccountSessionStore } from '../auth/redis-account-session-store.js';
import { createMetrics } from '../metrics/index.js';
import { buildServer } from './server.js';

const config = loadIntegrationConfig();
const origin = 'http://localhost:5174';
const FIRST_CODE = '731905';
const SECOND_CODE = '264810';

test('confirmação por código de 6 dígitos: erros, esgotamento, reenvio, métrica e log sem segredo', async () => {
  const logs = captureLogs();
  const db = createDatabase(config, logs.logger);
  const keys = new TestKeyspace();
  const prefix = keys.scopedPrefix('accounts-verification');
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
  const metrics = createMetrics();
  // Um sorteio por chamada de register/resend, mesmo quando o reenvio é barrado pelo intervalo:
  // o segundo valor é descartado pelo reenvio antecipado e o terceiro é o código reenviado.
  const codes = [Number(FIRST_CODE), 100_001, Number(SECOND_CODE)];
  let clock = Date.now();
  const mail = new Map<string, string>();
  const service = new AccountService({
    accounts: new PrismaAccountRepository(db.prisma),
    passwords,
    sessions: new RedisAccountSessionStore(redis.client, prefix),
    loginLocks: auth.sessions,
    loginSecret: config.JWT_SECRET,
    now: () => new Date(clock),
    randomInt: () => codes.shift() ?? 555_555,
    // Como em src/index.ts: só id e resultado.
    onVerificationAttempt: (result, accountId) => {
      metrics.countVerificationAttempt(result);
      logs.logger.info({ accountId, result }, 'tentativa de confirmação');
    },
    mailer: {
      sendVerification: (email, code) => {
        mail.set(email, code);
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
    app.inject({
      method: 'POST',
      url,
      payload,
      headers: { origin, 'x-soprei-client': 'web' },
    });
  const email = `verificacao-${randomUUID()}@example.test`;
  const password = `Dono1-${randomUUID()}`;
  const verify = (code: unknown) => post('/auth/verify-email', { email, password, code });
  const row = () => db.prisma.account.findUnique({ where: { email } });
  // O requestId muda a cada resposta: compara só o que precisa ser uniforme.
  const errorOf = (response: Awaited<ReturnType<typeof verify>>) => {
    const { code, message } = response.json<{ error: { code: string; message: string } }>().error;
    return { code, message };
  };
  try {
    assert.equal((await post('/auth/register', { email, password })).statusCode, 202);
    await service.drain();
    assert.equal(mail.get(email), FIRST_CODE);
    const first = await row();
    assert.ok(first?.verificationHash);
    const firstHash = first.verificationHash;
    // HMAC em hex, nunca o código.
    assert.match(firstHash, /^[0-9a-f]{64}$/);
    assert.notEqual(firstHash, FIRST_CODE);

    // Formato inválido: 400, sem consulta e sem contar (nem a chave antiga `token`).
    for (const code of ['12345', '1234567', '12345a', '12 3456', '', 123456]) {
      assert.equal((await verify(code)).statusCode, 400, String(code));
    }
    assert.equal(
      (await post('/auth/verify-email', { email, password, token: FIRST_CODE })).statusCode,
      400,
    );
    assert.equal((await row())?.verificationAttempts, 0);

    // Quatro erros e o quinto esgotam o código; a resposta é sempre a mesma 401.
    const wrong = [];
    for (const guess of ['000001', '000002', '000003', '000004', '000005']) {
      wrong.push(await verify(guess));
    }
    for (const response of wrong) {
      assert.equal(response.statusCode, 401);
      assert.deepEqual(errorOf(response), {
        code: 'UNAUTHORIZED',
        message: 'Confirmação inválida ou expirada',
      });
    }
    const dead = await row();
    assert.ok(dead);
    assert.equal(dead.verificationAttempts, 5);
    assert.equal(dead.verificationHash, null);
    assert.equal(dead.emailVerifiedAt, null);
    // O código certo depois do 5º erro responde igual e não confirma.
    const afterDeath = await verify(FIRST_CODE);
    assert.equal(afterDeath.statusCode, 401);
    assert.deepEqual(errorOf(afterDeath), errorOf(wrong[0] ?? afterDeath));
    assert.equal((await row())?.emailVerifiedAt, null);
    assert.equal(
      (await post('/auth/login', { email, password })).statusCode,
      403,
      'conta sem confirmação não entra',
    );

    // Reenvio antes de 60 s do envio: nada é enviado. Depois, código novo e contador zerado.
    assert.equal((await post('/auth/resend-verification', { email, password })).statusCode, 202);
    assert.equal(mail.get(email), FIRST_CODE);
    clock += 61_000;
    assert.equal((await post('/auth/resend-verification', { email, password })).statusCode, 202);
    assert.equal(mail.get(email), SECOND_CODE);
    const renewed = await row();
    assert.ok(renewed);
    assert.equal(renewed.verificationAttempts, 0);
    assert.notEqual(renewed.verificationHash, firstHash);
    // O código antigo morreu com o reenvio; o novo confirma.
    assert.equal((await verify(FIRST_CODE)).statusCode, 401);
    assert.equal((await verify(SECOND_CODE)).statusCode, 204);
    const done = await row();
    assert.ok(done?.emailVerifiedAt);
    assert.equal(done.verificationHash, null);
    assert.equal(done.verificationFailuresDay, 0);

    // Métrica: resultados fixos, sem id, e-mail, IP nem código.
    const body = await metrics.render();
    for (const line of [
      'account_verification_attempts_total{result="wrong"} 5',
      'account_verification_attempts_total{result="exhausted"} 1',
      'account_verification_attempts_total{result="unavailable"} 1',
      'account_verification_attempts_total{result="verified"} 1',
    ]) {
      assert.ok(body.includes(line), line);
    }
    const series = body
      .split(String.fromCharCode(10))
      .filter((line) => line.startsWith('account_verification_attempts_total{'));
    assert.equal(series.length, 4);
    for (const secret of [email, password, FIRST_CODE, SECOND_CODE, firstHash]) {
      assert.ok(!body.includes(secret));
    }

    // Log de todo o fluxo: sem código, hash, e-mail nem senha.
    const raw = logs.raw();
    for (const secret of [
      FIRST_CODE,
      SECOND_CODE,
      firstHash,
      renewed.verificationHash ?? firstHash,
      email,
      password,
    ]) {
      assert.ok(!logContains(raw, secret), 'segredo no log');
    }
  } finally {
    await app.close();
    await db.prisma.account.deleteMany({ where: { email } });
    await keys.cleanup(redis.client);
    await redis.close();
    await db.close();
  }
});
