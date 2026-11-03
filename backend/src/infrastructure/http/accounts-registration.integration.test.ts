import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccountService } from '../../application/auth/account.service.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { TestKeyspace } from '../../test-support/test-keyspace.js';
import { Result } from '../../shared/types/index.js';
import { createDatabase, PrismaAccountRepository } from '../database/index.js';
import { createAuthRedis } from '../auth/auth-redis.js';
import { createAuthComponents } from '../auth/create-auth.js';
import { ScryptPasswordHasher } from '../auth/scrypt-password-hasher.js';
import { RedisAccountSessionStore } from '../auth/redis-account-session-store.js';
import { buildServer } from './server.js';

const config = loadIntegrationConfig();
const origin = 'http://localhost:5174';

test('cadastro público: dono real do e-mail assume conta não confirmada; confirmada não muda; 202 uniforme', async () => {
  const logs = captureLogs();
  const db = createDatabase(config, logs.logger);
  const keys = new TestKeyspace();
  const prefix = keys.scopedPrefix('accounts-registration');
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
  let clock = Date.now();
  const mail = new Map<string, string>();
  const sent: string[] = [];
  const results: string[] = [];
  let mailFails = false;
  const service = new AccountService({
    accounts: repo,
    passwords,
    sessions: new RedisAccountSessionStore(redis.client, prefix),
    loginLocks: auth.sessions,
    loginSecret: config.JWT_SECRET,
    now: () => new Date(clock),
    onVerificationMail: (result) => results.push(result),
    mailer: {
      sendVerification: (email, code) => {
        if (mailFails) return Promise.reject(new Error('SMTP segredo que não pode vazar'));
        mail.set(email, code);
        sent.push(email);
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
  const headers = { origin, 'x-soprei-client': 'web' };
  const post = (url: string, payload: object) =>
    app.inject({ method: 'POST', url, payload, headers });
  const emails = [0, 1, 2, 3].map(() => `reg-${randomUUID()}@example.test`);
  const [victim, confirmedEmail, burst, failing] = emails as [string, string, string, string];
  const attackerPassword = 'Atacante1-' + randomUUID();
  const ownerPassword = 'Dono1-' + randomUUID();
  try {
    // 1. O atacante cadastra o e-mail da vítima; o código vai para a caixa da vítima.
    assert.equal(
      (await post('/auth/register', { email: victim, password: attackerPassword })).statusCode,
      202,
    );
    await service.drain();
    const attackerCode = mail.get(victim);
    assert.ok(attackerCode);
    // Sem o código, o atacante não confirma; e a conta não entra antes de confirmar.
    const guess = attackerCode === '000001' ? '000002' : '000001';
    assert.equal(
      (
        await post('/auth/verify-email', {
          email: victim,
          password: attackerPassword,
          code: guess,
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (await post('/auth/login', { email: victim, password: attackerPassword })).statusCode,
      403,
    );
    // 2. A vítima se cadastra logo em seguida: intervalo mínimo, nada é enviado nem alterado.
    assert.equal(
      (await post('/auth/register', { email: victim, password: ownerPassword })).statusCode,
      202,
    );
    await service.drain();
    assert.equal(sent.filter((e) => e === victim).length, 1);
    assert.equal(
      (await post('/auth/login', { email: victim, password: ownerPassword })).statusCode,
      401,
    );
    // 3. Passado o intervalo, a vítima assume: senha nova, código novo, o anterior morre.
    clock += 61_000;
    assert.equal(
      (await post('/auth/register', { email: victim, password: ownerPassword })).statusCode,
      202,
    );
    await service.drain();
    const ownerCode = mail.get(victim);
    assert.ok(ownerCode);
    assert.notEqual(ownerCode, attackerCode);
    assert.equal(sent.filter((e) => e === victim).length, 2);
    // A senha do atacante não vale mais, nem o código antigo com a senha nova.
    for (const [password, code] of [
      [attackerPassword, attackerCode],
      [attackerPassword, ownerCode],
      [ownerPassword, attackerCode],
    ] as const) {
      assert.equal(
        (await post('/auth/verify-email', { email: victim, password, code })).statusCode,
        401,
      );
    }
    assert.equal(
      (await post('/auth/login', { email: victim, password: ownerPassword })).statusCode,
      403,
    );
    assert.equal(
      (
        await post('/auth/verify-email', {
          email: victim,
          password: ownerPassword,
          code: ownerCode,
        })
      ).statusCode,
      204,
    );
    assert.equal(
      (await post('/auth/login', { email: victim, password: ownerPassword })).statusCode,
      204,
    );
    assert.equal(
      (await post('/auth/login', { email: victim, password: attackerPassword })).statusCode,
      401,
    );
    // 4. Conta confirmada: cadastro repetido não envia nada, não troca a senha nem o vínculo.
    clock += 3_600_000;
    const before = sent.length;
    assert.equal(
      (await post('/auth/register', { email: victim, password: attackerPassword })).statusCode,
      202,
    );
    await service.drain();
    assert.equal(sent.length, before);
    assert.equal(
      (await post('/auth/login', { email: victim, password: attackerPassword })).statusCode,
      401,
    );
    assert.equal(
      (await post('/auth/login', { email: victim, password: ownerPassword })).statusCode,
      204,
    );
    // 5. Resposta idêntica para novo, não confirmado e confirmado.
    const shape = async (email: string, password: string) => {
      const response = await post('/auth/register', { email, password });
      await service.drain();
      const rest = { ...response.headers };
      delete rest.date;
      delete rest['x-request-id'];
      return { status: response.statusCode, body: response.body, headers: rest };
    };
    const fresh = await shape(confirmedEmail, ownerPassword);
    clock += 61_000;
    const unconfirmed = await shape(confirmedEmail, ownerPassword);
    await post('/auth/verify-email', {
      email: confirmedEmail,
      password: ownerPassword,
      code: mail.get(confirmedEmail) ?? '',
    });
    const confirmed = await shape(confirmedEmail, ownerPassword);
    assert.equal(fresh.status, 202);
    assert.deepEqual(unconfirmed, fresh);
    assert.deepEqual(confirmed, fresh);
    // 6. Reenvio autenticado respeita o intervalo mínimo e invalida o código anterior.
    const resendEmail = `resend-${randomUUID()}@example.test`;
    emails.push(resendEmail);
    await post('/auth/register', { email: resendEmail, password: ownerPassword });
    await service.drain();
    const first = mail.get(resendEmail);
    assert.ok(first);
    const resendBefore = sent.length;
    assert.equal(
      (await post('/auth/resend-verification', { email: resendEmail, password: ownerPassword }))
        .statusCode,
      202,
    );
    assert.equal(sent.length, resendBefore);
    clock += 61_000;
    assert.equal(
      (await post('/auth/resend-verification', { email: resendEmail, password: ownerPassword }))
        .statusCode,
      202,
    );
    assert.equal(sent.length, resendBefore + 1);
    assert.notEqual(mail.get(resendEmail), first);
    assert.equal(
      (
        await post('/auth/verify-email', {
          email: resendEmail,
          password: ownerPassword,
          code: first,
        })
      ).statusCode,
      401,
    );
    // 7. Cadastros simultâneos do mesmo e-mail enviam um único código.
    const burstResults = await Promise.all(
      Array.from({ length: 6 }, () =>
        post('/auth/register', { email: burst, password: ownerPassword }),
      ),
    );
    assert.ok(burstResults.every((response) => response.statusCode === 202));
    await service.drain();
    assert.equal(sent.filter((e) => e === burst).length, 1);
    // 8. Mailer falho: o cadastro continua 202; só id e resultado vão para o observador.
    mailFails = true;
    assert.equal(
      (await post('/auth/register', { email: failing, password: ownerPassword })).statusCode,
      202,
    );
    await service.drain();
    assert.ok(results.includes('failed'));
    mailFails = false;
    // A falha liberou novo cadastro/reenvio imediato (nada tinha saído).
    assert.equal(
      (await post('/auth/register', { email: failing, password: ownerPassword })).statusCode,
      202,
    );
    await service.drain();
    assert.equal(sent.filter((e) => e === failing).length, 1);
    for (const value of [
      ownerPassword,
      attackerPassword,
      ...emails,
      ...mail.values(),
      attackerCode,
      'SMTP segredo',
    ]) {
      assert.ok(!logs.raw().includes(value));
    }
  } finally {
    await app.close();
    await db.prisma.account.deleteMany({ where: { email: { in: emails } } });
    await keys.cleanup(redis.client);
    await redis.close();
    await db.close();
  }
});
