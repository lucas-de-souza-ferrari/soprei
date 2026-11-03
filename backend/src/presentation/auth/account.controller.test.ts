import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import type { AccountService } from '../../application/auth/account.service.js';
import { buildServer } from '../../infrastructure/http/server.js';
import { ServiceUnavailableError, UnauthorizedError } from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { accountCookie, cookieIsSecure, verificationSchema } from './account.controller.js';

test('cookie de conta recusa ausência, formato adulterado e cookies duplicados', () => {
  const secret = randomBytes(32).toString('base64url');
  assert.equal(accountCookie(`other=value; soprei_session=${secret}`), secret);
  for (const value of [
    undefined,
    '',
    'soprei_session=abc',
    `soprei_session=${secret}; soprei_session=${secret}`,
    `soprei_session=${secret}%0a`,
  ]) {
    assert.throws(() => accountCookie(value));
  }
});

test('logout só limpa o cookie depois de revogar; 503 mantém o cookie', async () => {
  const secret = randomBytes(32).toString('base64url');
  let fail = true;
  const service = {
    drain: () => Promise.resolve(),
    logout: () =>
      fail ? Promise.reject(new ServiceUnavailableError('Sessão indisponível')) : Promise.resolve(),
  } as unknown as AccountService;
  const app = buildServer({
    logger: captureLogs().logger,
    readiness: {
      database: () => Promise.resolve(Result.ok(undefined)),
      redis: () => Promise.resolve(Result.ok(undefined)),
    },
    accounts: { service, origin: 'http://localhost:5174', secure: false },
  });
  const request = (cookie?: string) =>
    app.inject({
      method: 'POST',
      url: '/auth/logout',
      payload: {},
      headers: {
        origin: 'http://localhost:5174',
        'x-soprei-client': 'web',
        ...(cookie === undefined ? {} : { cookie }),
      },
    });
  try {
    const failed = await request(`soprei_session=${secret}`);
    assert.equal(failed.statusCode, 503);
    assert.equal(failed.headers['set-cookie'], undefined);
    fail = false;
    const ok = await request(`soprei_session=${secret}`);
    assert.equal(ok.statusCode, 204);
    assert.match(String(ok.headers['set-cookie']), /Max-Age=0/);
    // Sem cookie válido não há o que revogar: limpar é seguro e idempotente.
    assert.equal((await request()).statusCode, 204);
  } finally {
    await app.close();
  }
});

test('cookie Secure em produção ou com origem HTTPS', () => {
  assert.equal(cookieIsSecure('production', 'http://localhost:5174'), true);
  assert.equal(cookieIsSecure('development', 'https://staging.example.test'), true);
  assert.equal(cookieIsSecure('development', 'HTTPS://staging.example.test'), true);
  assert.equal(cookieIsSecure('development', 'http://localhost:5174'), false);
  assert.equal(cookieIsSecure('test', ''), false);
});

const CREDENTIALS = { email: 'pessoa@example.test', password: 'Senha1-valida' };

test('corpo de confirmação: aceita só code com exatamente 6 dígitos (a chave token antiga é recusada)', () => {
  for (const code of ['123456', '000000', '999999']) {
    assert.equal(verificationSchema.safeParse({ ...CREDENTIALS, code }).success, true, code);
  }
  for (const code of [
    '12345',
    '1234567',
    '12345a',
    '12 3456',
    ' 123456',
    '',
    '4SaUJXk9zCcO1mvSQNy3-Dh5IRi8yRcwS9-pAiOujlw',
  ]) {
    assert.equal(verificationSchema.safeParse({ ...CREDENTIALS, code }).success, false, code);
  }
  assert.equal(verificationSchema.safeParse({ ...CREDENTIALS, token: '123456' }).success, false);
  assert.equal(
    verificationSchema.safeParse({ ...CREDENTIALS, code: '123456', token: 'x' }).success,
    false,
  );
  assert.equal(verificationSchema.safeParse(CREDENTIALS).success, false);
  assert.equal(verificationSchema.safeParse({ ...CREDENTIALS, code: 123456 }).success, false);
});

test('POST /auth/verify-email: formato inválido é 400 e nunca chega ao serviço; 401 do serviço é uniforme', async () => {
  const calls: unknown[][] = [];
  let reject = false;
  const service = {
    drain: () => Promise.resolve(),
    verify: (...args: unknown[]) => {
      calls.push(args);
      return reject
        ? Promise.reject(new UnauthorizedError('Confirmação inválida ou expirada'))
        : Promise.resolve();
    },
  } as unknown as AccountService;
  const app = buildServer({
    logger: captureLogs().logger,
    readiness: {
      database: () => Promise.resolve(Result.ok(undefined)),
      redis: () => Promise.resolve(Result.ok(undefined)),
    },
    accounts: { service, origin: 'http://localhost:5174', secure: false },
  });
  const post = (payload: object) =>
    app.inject({
      method: 'POST',
      url: '/auth/verify-email',
      payload,
      headers: { origin: 'http://localhost:5174', 'x-soprei-client': 'web' },
    });
  try {
    for (const payload of [
      { ...CREDENTIALS, code: '12345' },
      { ...CREDENTIALS, code: '1234567' },
      { ...CREDENTIALS, code: 'abcdef' },
      { ...CREDENTIALS, code: '' },
      { ...CREDENTIALS, token: '123456' },
      CREDENTIALS,
    ]) {
      assert.equal((await post(payload)).statusCode, 400, JSON.stringify(payload));
    }
    assert.equal(calls.length, 0);
    const ok = await post({ ...CREDENTIALS, code: '012345' });
    assert.equal(ok.statusCode, 204);
    assert.deepEqual(calls, [[CREDENTIALS.email, CREDENTIALS.password, '012345']]);
    reject = true;
    const refused = await post({ ...CREDENTIALS, code: '654321' });
    assert.equal(refused.statusCode, 401);
    assert.equal(
      refused.json<{ error: { message: string } }>().error.message,
      'Confirmação inválida ou expirada',
    );
  } finally {
    await app.close();
  }
});
