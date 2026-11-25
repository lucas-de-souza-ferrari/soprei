import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { PlatformAdminId } from '../../domain/index.js';
import { buildTestAuth, TEST_PASSWORD } from '../../test-support/in-memory-auth.js';
import {
  codeAt,
  enrollTestAdmin,
  ManualClock,
  testPlatformCipher,
} from '../../test-support/in-memory-platform.js';
import { captureLogs } from '../../test-support/log-capture.js';

// Spec 045, regra comum 3 (D2): confirmação reforçada das ações de impacto com um código NOVO do
// autenticador, no mesmo bloqueio por conta do login da plataforma.

function setup(options: { totp?: boolean } = {}) {
  const logs = captureLogs();
  const clock = new ManualClock();
  const cipher = testPlatformCipher();
  const auth = buildTestAuth({
    logger: logs.logger,
    maxFailures: 3,
    ...(options.totp === false ? {} : { platformTotp: { cipher, now: clock.now } }),
  });
  return { logs, clock, cipher, auth };
}

describe('AuthService.confirmPlatformCode (spec 045, E2)', () => {
  it('código novo confere; o mesmo passo não vale duas vezes, nem o já usado no login', async () => {
    const { clock, cipher, auth } = setup();
    const admin = await enrollTestAdmin(auth, cipher);
    const login = await auth.service.verifyPlatformCredentials({
      email: admin.email,
      password: TEST_PASSWORD,
      code: codeAt(admin.secret, clock.ms),
    });
    assert.ok(login.ok);
    const used = await auth.service.confirmPlatformCode(
      admin.adminId,
      codeAt(admin.secret, clock.ms),
    );
    assert.deepEqual(used, { ok: false, error: { reason: 'invalid_credentials' } });

    clock.advanceSeconds(30);
    const fresh = codeAt(admin.secret, clock.ms);
    assert.ok((await auth.service.confirmPlatformCode(admin.adminId, fresh)).ok);
    assert.equal((await auth.service.confirmPlatformCode(admin.adminId, fresh)).ok, false);
  });

  it('código errado conta no bloqueio do login da plataforma: estourado, locked (com Retry-After) antes de conferir, e o login também fica bloqueado', async () => {
    const { clock, cipher, auth, logs } = setup();
    const admin = await enrollTestAdmin(auth, cipher);
    for (let i = 0; i < 3; i++) {
      const wrong = await auth.service.confirmPlatformCode(admin.adminId, '000000');
      assert.deepEqual(wrong, { ok: false, error: { reason: 'invalid_credentials' } });
    }
    clock.advanceSeconds(30);
    const locked = await auth.service.confirmPlatformCode(
      admin.adminId,
      codeAt(admin.secret, clock.ms),
    );
    assert.ok(!locked.ok && locked.error.reason === 'locked' && locked.error.retryAfterSeconds > 0);
    // O código certo não foi gasto: o bloqueio responde antes de conferir.
    const login = await auth.service.verifyPlatformCredentials({
      email: admin.email,
      password: TEST_PASSWORD,
      code: codeAt(admin.secret, clock.ms),
    });
    assert.ok(!login.ok && login.error.reason === 'locked', 'o login da plataforma também');
    assert.ok(!logs.raw().includes(admin.email), 'o log nunca leva o e-mail');
  });

  it('sem segundo fator configurado ou admin inexistente: nunca confirma', async () => {
    const plain = setup({ totp: false });
    const admin = await enrollTestAdmin(plain.auth, plain.cipher);
    assert.equal(
      (
        await plain.auth.service.confirmPlatformCode(
          admin.adminId,
          codeAt(admin.secret, plain.clock.ms),
        )
      ).ok,
      false,
    );
    const { auth } = setup();
    assert.deepEqual(
      await auth.service.confirmPlatformCode(PlatformAdminId.parse(randomUUID()), '123456'),
      { ok: false, error: { reason: 'invalid_credentials' } },
    );
  });
});
