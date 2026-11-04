import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AccountService } from '../../application/auth/account.service.js';
import { buildServer } from '../../infrastructure/http/server.js';
import { UnauthorizedError } from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { passwordResetConfirmSchema, passwordResetRequestSchema } from './account.controller.js';

const ORIGIN = 'http://localhost:5174';
const CONFIRM = { email: 'pessoa@example.test', code: '123456', newPassword: 'Senha1-nova' };

test('schema do pedido: só o e-mail; campo extra é recusado', () => {
  assert.equal(passwordResetRequestSchema.safeParse({ email: 'a@example.test' }).success, true);
  assert.equal(
    passwordResetRequestSchema.safeParse({ email: ' A@Example.TEST ' }).data?.email,
    'a@example.test',
  );
  for (const body of [
    {},
    { email: 'a@example.test', extra: 1 },
    { email: 'a@example.test', code: '123456' },
    { email: 'nao-e-email' },
  ]) {
    assert.equal(passwordResetRequestSchema.safeParse(body).success, false, JSON.stringify(body));
  }
});

test('schema da confirmação: código de exatamente 6 dígitos, senha pela política do cadastro, sem campos extras', () => {
  for (const code of ['123456', '000000']) {
    assert.equal(passwordResetConfirmSchema.safeParse({ ...CONFIRM, code }).success, true, code);
  }
  for (const code of ['12345', '1234567', '12345a', '12 3456', ' 123456', '', 'abcdef']) {
    assert.equal(passwordResetConfirmSchema.safeParse({ ...CONFIRM, code }).success, false, code);
  }
  // A mesma política do cadastro público: 6 a 128 caracteres, maiúscula e número.
  assert.equal(
    passwordResetConfirmSchema.safeParse({ ...CONFIRM, newPassword: 'Abcde1' }).success,
    true,
  );
  for (const newPassword of ['Abc1', 'abcdef1', 'Abcdefg', `A1${'a'.repeat(127)}`, '']) {
    assert.equal(
      passwordResetConfirmSchema.safeParse({ ...CONFIRM, newPassword }).success,
      false,
      newPassword,
    );
  }
  const withoutCode = { email: CONFIRM.email, newPassword: CONFIRM.newPassword };
  assert.equal(passwordResetConfirmSchema.safeParse(withoutCode).success, false);
  assert.equal(
    passwordResetConfirmSchema.safeParse({ ...CONFIRM, token: '123456' }).success,
    false,
  );
  assert.equal(passwordResetConfirmSchema.safeParse({ ...CONFIRM, password: 'x' }).success, false);
  assert.equal(passwordResetConfirmSchema.safeParse({ ...CONFIRM, code: 123456 }).success, false);
});

function build(service: Partial<AccountService>) {
  const app = buildServer({
    logger: captureLogs().logger,
    readiness: {
      database: () => Promise.resolve(Result.ok(undefined)),
      redis: () => Promise.resolve(Result.ok(undefined)),
    },
    accounts: {
      service: { drain: () => Promise.resolve(), ...service } as unknown as AccountService,
      origin: ORIGIN,
      secure: false,
    },
  });
  const post = (
    url: string,
    payload: object,
    headers: Record<string, string> = { origin: ORIGIN, 'x-soprei-app': 'web' },
  ) => app.inject({ method: 'POST', url, payload, headers });
  return { app, post };
}

test('POST /auth/password-reset/request: sempre 202 com a mesma mensagem, sem cookie; formato inválido é 400 e não chega ao serviço', async () => {
  const calls: string[] = [];
  const { app, post } = build({
    requestPasswordReset: (email: string) => {
      calls.push(email);
      return Promise.resolve();
    },
  });
  try {
    const ok = await post('/auth/password-reset/request', { email: 'Pessoa@Example.test' });
    assert.equal(ok.statusCode, 202);
    assert.deepEqual(ok.json(), {
      message: 'Se existir uma conta, enviamos um código para o e-mail informado.',
    });
    assert.equal(ok.headers['set-cookie'], undefined);
    assert.equal(ok.headers['cache-control'], 'no-store');
    assert.deepEqual(calls, ['pessoa@example.test']);
    for (const payload of [{}, { email: 'x@example.test', extra: true }]) {
      assert.equal((await post('/auth/password-reset/request', payload)).statusCode, 400);
    }
    assert.equal(calls.length, 1);
  } finally {
    await app.close();
  }
});

test('POST /auth/password-reset/confirm: 204 sem cookie; 400 antes do serviço; 401 do serviço é repassada igual', async () => {
  const calls: unknown[][] = [];
  let reject = false;
  const { app, post } = build({
    confirmPasswordReset: (...args: [string, string, string]) => {
      calls.push(args);
      return reject
        ? Promise.reject(new UnauthorizedError('Código inválido ou expirado'))
        : Promise.resolve();
    },
  });
  try {
    for (const payload of [
      { ...CONFIRM, code: '12345' },
      { ...CONFIRM, code: '1234567' },
      { ...CONFIRM, code: 'abcdef' },
      { ...CONFIRM, newPassword: 'curta' },
      { ...CONFIRM, token: '123456' },
      { email: CONFIRM.email, newPassword: CONFIRM.newPassword },
    ]) {
      assert.equal(
        (await post('/auth/password-reset/confirm', payload)).statusCode,
        400,
        JSON.stringify(payload),
      );
    }
    assert.equal(calls.length, 0);
    const ok = await post('/auth/password-reset/confirm', CONFIRM);
    assert.equal(ok.statusCode, 204);
    assert.equal(ok.headers['set-cookie'], undefined);
    assert.deepEqual(calls, [[CONFIRM.email, CONFIRM.code, CONFIRM.newPassword]]);
    reject = true;
    const refused = await post('/auth/password-reset/confirm', CONFIRM);
    assert.equal(refused.statusCode, 401);
    const error = refused.json<{ error: { code: string; message: string } }>().error;
    assert.deepEqual(
      { code: error.code, message: error.message },
      { code: 'UNAUTHORIZED', message: 'Código inválido ou expirado' },
    );
  } finally {
    await app.close();
  }
});

test('as duas rotas exigem Origin e X-Soprei-App válidos (403 antes de qualquer trabalho)', async () => {
  const calls: string[] = [];
  const { app, post } = build({
    requestPasswordReset: () => {
      calls.push('request');
      return Promise.resolve();
    },
    confirmPasswordReset: () => {
      calls.push('confirm');
      return Promise.resolve();
    },
  });
  try {
    for (const url of ['/auth/password-reset/request', '/auth/password-reset/confirm']) {
      const payload = url.endsWith('request') ? { email: CONFIRM.email } : CONFIRM;
      const bad: Record<string, string>[] = [
        {},
        { origin: 'http://evil.example.test', 'x-soprei-app': 'web' },
        { origin: ORIGIN },
        { 'x-soprei-app': 'web' },
        // Spec 022: o cabeçalho antigo (X-Soprei-Client) não é alias do novo.
        { origin: ORIGIN, 'x-soprei-client': 'web' },
      ];
      for (const headers of bad) {
        assert.equal((await post(url, payload, headers)).statusCode, 403, url);
      }
    }
    assert.deepEqual(calls, []);
  } finally {
    await app.close();
  }
});
