import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountPasswordSchema, newPasswordSchema } from './credentials.js';

test('senha de cadastro exige seis caracteres, maiúscula e número após normalização', () => {
  for (const value of ['Abcde1', 'Árvore1', 'Ａbcde1']) {
    assert.equal(accountPasswordSchema.safeParse(value).success, true);
  }
  for (const value of ['Abc1', 'abcdef1', 'Abcdefg', 'Abcde1\u0000', `A1${'a'.repeat(127)}`]) {
    assert.equal(accountPasswordSchema.safeParse(value).success, false);
  }
  assert.equal(newPasswordSchema.safeParse('Abcde1').success, false);
});
