import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkFormToken, deriveSalesContactKey, issueFormToken } from './form-token.js';

const KEY = deriveSalesContactKey('s'.repeat(48));
const T0 = Date.UTC(2026, 10, 13, 12, 0, 0);

describe('token do formulário de contato (spec 040, D14)', () => {
  it('formato <emitidoEmMs>.<HMAC base64url>, sem estado', () => {
    const token = issueFormToken(KEY, T0);
    assert.match(token, /^\d+\.[A-Za-z0-9_-]{43}$/);
    assert.equal(token.split('.')[0], String(T0));
    assert.equal(issueFormToken(KEY, T0), token, 'determinístico');
  });

  it('menos de 3 s = too_fast; de 3 s a 2 h = ok; mais de 2 h = expired', () => {
    const token = issueFormToken(KEY, T0);
    assert.equal(checkFormToken(KEY, token, T0), 'too_fast');
    assert.equal(checkFormToken(KEY, token, T0 + 2_999), 'too_fast');
    assert.equal(checkFormToken(KEY, token, T0 + 3_000), 'ok');
    assert.equal(checkFormToken(KEY, token, T0 + 2 * 3_600_000), 'ok');
    assert.equal(checkFormToken(KEY, token, T0 + 2 * 3_600_000 + 1), 'expired');
  });

  it('token alterado, de outra chave, malformado ou do futuro = expired', () => {
    const token = issueFormToken(KEY, T0);
    const later = T0 + 10_000;
    const [issued, mac] = token.split('.') as [string, string];
    const flipped = (mac[0] === 'A' ? 'B' : 'A') + mac.slice(1);
    for (const bad of [
      `${issued}.${flipped}`,
      `${String(T0 - 5_000)}.${mac}`,
      issueFormToken(deriveSalesContactKey('o'.repeat(48)), T0),
      '',
      'abc',
      `${issued}.${mac}x`,
      `${issued}${mac}`,
    ]) {
      assert.equal(checkFormToken(KEY, bad, later), 'expired', bad);
    }
    assert.equal(checkFormToken(KEY, issueFormToken(KEY, later + 120_000), later), 'expired');
  });
});
