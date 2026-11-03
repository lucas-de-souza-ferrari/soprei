import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { accountCookie } from './account.controller.js';

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
