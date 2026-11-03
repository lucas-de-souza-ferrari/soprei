import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  VERIFICATION_CODE_LENGTH,
  isCompleteVerificationCode,
  normalizeVerificationCode,
} from './verification-code';

test('colar com ou sem separadores produz os mesmos 6 dígitos', () => {
  for (const pasted of ['123 456', '123-456', '123456', ' 123.456 ', '1 2 3 4 5 6', '123 456']) {
    assert.equal(normalizeVerificationCode(pasted), '123456', JSON.stringify(pasted));
  }
});

test('letras e símbolos são descartados e o excesso é cortado em 6', () => {
  assert.equal(normalizeVerificationCode('abc12x3'), '123');
  assert.equal(normalizeVerificationCode('12345678'), '123456');
  assert.equal(normalizeVerificationCode('987 654 321'), '987654');
  assert.equal(normalizeVerificationCode(''), '');
  assert.equal(normalizeVerificationCode('abc'), '');
  // Dígitos de outros alfabetos não são aceitos (o servidor só aceita 0-9).
  assert.equal(normalizeVerificationCode('١٢٣'), '');
  assert.equal(VERIFICATION_CODE_LENGTH, 6);
});

test('só seis dígitos completam o código', () => {
  assert.equal(isCompleteVerificationCode('123456'), true);
  assert.equal(isCompleteVerificationCode('000000'), true);
  for (const value of ['', '12345', '1234567', '12345a', '12 3456']) {
    assert.equal(isCompleteVerificationCode(value), false, value);
  }
});
