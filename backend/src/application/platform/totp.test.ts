import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  matchTotp,
  otpauthUri,
  TOTP_SECRET_BYTES,
  totpCode,
  totpStep,
} from './totp.js';

// Segredo e instantes do apêndice B da RFC 6238 (SHA-1). Os valores de 6 dígitos são os 6 últimos dos de 8.
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS: readonly (readonly [number, string])[] = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130'],
];

describe('TOTP (spec 044, E1)', () => {
  it('confere os vetores da RFC 6238 (SHA-1, 6 dígitos)', () => {
    for (const [seconds, expected] of RFC_VECTORS) {
      assert.equal(totpCode(RFC_SECRET, totpStep(seconds * 1000)), expected, String(seconds));
    }
  });

  it('aceita o passo atual e um vizinho de cada lado; dois passos fora não', () => {
    const now = 1_111_111_111_000;
    const step = totpStep(now);
    assert.equal(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step), now), step);
    assert.equal(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), now), step - 1);
    assert.equal(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), now), step + 1);
    assert.equal(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2), now), undefined);
    assert.equal(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 2), now), undefined);
  });

  it('recusa formato que não é de 6 dígitos sem comparar nada', () => {
    const now = 59_000;
    for (const code of ['', '28708', '2870822', 'abcdef', ' 287082', '２８７０８２']) {
      assert.equal(matchTotp(RFC_SECRET, code, now), undefined, JSON.stringify(code));
    }
  });

  it('base32 ida e volta; texto fora do alfabeto é undefined', () => {
    for (let i = 0; i < 20; i += 1) {
      const secret = generateTotpSecret();
      assert.equal(secret.length, TOTP_SECRET_BYTES);
      const encoded = base32Encode(secret);
      assert.match(encoded, /^[A-Z2-7]+$/);
      assert.deepEqual(base32Decode(encoded), secret);
    }
    assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
    assert.equal(base32Decode('MZXW6YTB01'), undefined);
  });

  it('a URI otpauth leva o segredo e o emissor, nunca o e-mail', () => {
    const uri = otpauthUri('MZXW6YTBOI');
    assert.match(uri, /^otpauth:\/\/totp\/Soprei:plataforma\?/);
    const params = new URL(uri).searchParams;
    assert.equal(params.get('secret'), 'MZXW6YTBOI');
    assert.equal(params.get('issuer'), 'Soprei');
    assert.equal(params.get('digits'), '6');
    assert.equal(params.get('period'), '30');
    assert.doesNotMatch(uri, /@/);
  });
});
