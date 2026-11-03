import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import type { AccountService } from '../../application/auth/account.service.js';
import { buildServer } from '../../infrastructure/http/server.js';
import { ServiceUnavailableError } from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { accountCookie, cookieIsSecure } from './account.controller.js';

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
