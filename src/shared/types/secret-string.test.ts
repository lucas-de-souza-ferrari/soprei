import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { SecretString } from './secret-string.js';

test('SecretString: só reveal() dá o valor', () => {
  const secret = new SecretString('token-super-secreto');
  assert.equal(secret.reveal(), 'token-super-secreto');
  for (const shown of [
    String(secret),
    `token=${secret.toString()}`,
    JSON.stringify(secret),
    JSON.stringify({ token: secret }),
    inspect(secret),
    inspect({ a: { secret } }),
  ]) {
    assert.ok(!shown.includes('super-secreto'), shown);
  }
  assert.equal(String(secret), '[redacted]');
  assert.equal(`x${String(secret)}`, 'x[redacted]');
});
