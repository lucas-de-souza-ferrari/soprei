import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PlatformAdminId } from '../../domain/index.js';
import { createLogger } from '../../infrastructure/logger/logger.js';
import {
  AesGcmCredentialCipher,
  AesGcmPlatformSecretCipher,
  parseCredentialKeys,
} from '../../infrastructure/security/aes-gcm-credential-cipher.js';
import { CredentialDecryptionError } from '../../shared/errors/index.js';
import { SecretString } from '../../shared/types/index.js';
import { buildTestAuth } from '../../test-support/in-memory-auth.js';
import {
  codeAt,
  enrollTestAdmin,
  ManualClock,
  TEST_PLATFORM_TOTP_KEYS,
  testPlatformCipher,
} from '../../test-support/in-memory-platform.js';
import { captureLogs, logContains } from '../../test-support/log-capture.js';
import { CompanyId } from '../../domain/index.js';
import { factorFingerprint, TotpSecondFactor } from './totp-second-factor.js';

const silent = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });

function setup() {
  const clock = new ManualClock();
  const cipher = testPlatformCipher();
  const auth = buildTestAuth({ logger: silent });
  const factor = new TotpSecondFactor({
    cipher,
    admins: auth.platformAdmins,
    logger: silent,
    now: clock.now,
  });
  return { clock, cipher, auth, factor };
}

describe('cifra do segredo TOTP (spec 044)', () => {
  it('ida e volta com o mesmo admin; outro admin ou a cifra do canal não decifram', () => {
    const cipher = testPlatformCipher();
    const a = PlatformAdminId.parse('0190a000-0000-7000-8000-000000000001');
    const b = PlatformAdminId.parse('0190a000-0000-7000-8000-000000000002');
    const stored = cipher.encrypt(a, new SecretString('SEGREDO'));
    assert.match(stored, /^v1\.t1\./);
    assert.equal(cipher.decrypt(a, stored).reveal(), 'SEGREDO');
    assert.throws(() => cipher.decrypt(b, stored), CredentialDecryptionError);

    const parsed = parseCredentialKeys(TEST_PLATFORM_TOTP_KEYS);
    assert.ok(parsed.ok);
    const channel = new AesGcmCredentialCipher(parsed.keys, 't1');
    // Mesma chave, finalidade diferente: a AAD separa os dois usos.
    assert.throws(
      () => channel.decrypt(CompanyId.parse(a), stored),
      (error: unknown) => error instanceof CredentialDecryptionError && error.reason === 'tampered',
    );
    assert.throws(
      () => new AesGcmPlatformSecretCipher(parsed.keys, 'outra'),
      /chave ativa de credenciais ausente/,
    );
  });
});

describe('TotpSecondFactor (spec 044, E1)', () => {
  it('aceita o código atual uma única vez; o mesmo código (ou um passo anterior) não entra de novo', async () => {
    const { clock, cipher, auth, factor } = setup();
    const admin = await enrollTestAdmin(auth, cipher);
    const stored = await auth.platformAdmins.findTotpSecret(admin.adminId);
    const code = codeAt(admin.secret, clock.ms);
    assert.equal(await factor.verify(admin.adminId, stored, code), true);
    assert.equal(await factor.verify(admin.adminId, stored, code), false);
    assert.equal(
      await factor.verify(admin.adminId, stored, codeAt(admin.secret, clock.ms, -1)),
      false,
    );
    clock.advanceSeconds(30);
    assert.equal(await factor.verify(admin.adminId, stored, codeAt(admin.secret, clock.ms)), true);
  });

  it('sem fator, sem código ou com código errado: false', async () => {
    const { clock, cipher, auth, factor } = setup();
    const admin = await enrollTestAdmin(auth, cipher);
    const stored = await auth.platformAdmins.findTotpSecret(admin.adminId);
    assert.equal(await factor.verify(admin.adminId, null, codeAt(admin.secret, clock.ms)), false);
    assert.equal(await factor.verify(admin.adminId, stored, undefined), false);
    const wrong = codeAt(admin.secret, clock.ms) === '000000' ? '111111' : '000000';
    assert.equal(await factor.verify(admin.adminId, stored, wrong), false);
  });

  it('texto cifrado adulterado: false, com warn só do motivo (sem segredo nem código)', async () => {
    const { clock, cipher, auth } = setup();
    const admin = await enrollTestAdmin(auth, cipher);
    const stored = await auth.platformAdmins.findTotpSecret(admin.adminId);
    assert.ok(stored !== null);
    const tampered = `${stored.slice(0, -2)}AA`;
    const code = codeAt(admin.secret, clock.ms);
    const capture = captureLogs();
    const factor = new TotpSecondFactor({
      cipher,
      admins: auth.platformAdmins,
      logger: capture.logger,
      now: clock.now,
    });
    assert.equal(await factor.verify(admin.adminId, tampered, code), false);
    const text = capture.raw();
    assert.match(text, /segundo fator não decifra/);
    assert.equal(logContains(text, code), false);
    assert.equal(text.includes(stored.slice(10, 30)), false);
  });

  it('a impressão digital muda quando o fator é recadastrado', () => {
    const cipher = testPlatformCipher();
    const id = PlatformAdminId.parse('0190a000-0000-7000-8000-000000000003');
    const first = cipher.encrypt(id, new SecretString('A'));
    const second = cipher.encrypt(id, new SecretString('A'));
    assert.match(factorFingerprint(first), /^[0-9a-f]{32}$/);
    assert.notEqual(factorFingerprint(first), factorFingerprint(second));
  });
});
