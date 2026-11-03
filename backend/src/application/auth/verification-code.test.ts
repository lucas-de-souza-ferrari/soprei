import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  VERIFICATION_CODE_PATTERN,
  deriveVerificationKey,
  generateVerificationCode,
  verificationDigest,
} from './verification-code.js';

test('o código vira 6 dígitos com zeros à esquerda a partir do valor sorteado', () => {
  const asked: [number, number][] = [];
  const source = (value: number) => (min: number, max: number) => {
    asked.push([min, max]);
    return value;
  };
  assert.equal(generateVerificationCode(source(0)), '000000');
  assert.equal(generateVerificationCode(source(42)), '000042');
  assert.equal(generateVerificationCode(source(999_999)), '999999');
  assert.equal(generateVerificationCode(source(482_913)), '482913');
  // Sempre `[0, 1_000_000)`: sem módulo sobre bytes.
  for (const [min, max] of asked) {
    assert.equal(min, 0);
    assert.equal(max, 1_000_000);
  }
});

test('com o sorteio real o código tem sempre 6 caracteres 0-9', () => {
  for (let i = 0; i < 500; i += 1) {
    assert.match(generateVerificationCode(), VERIFICATION_CODE_PATTERN);
  }
});

test('o formato aceito é exatamente seis dígitos ASCII', () => {
  for (const ok of ['123456', '000000', '999999']) assert.match(ok, VERIFICATION_CODE_PATTERN);
  for (const bad of [
    '',
    '12345',
    '1234567',
    '12345a',
    '12 3456',
    ' 123456',
    '123456 ',
    '123456\n',
    '١٢٣٤٥٦',
    '4SaUJXk9zCcO1mvSQNy3-Dh5IRi8yRcwS9-pAiOujlw',
  ]) {
    assert.doesNotMatch(bad, VERIFICATION_CODE_PATTERN, JSON.stringify(bad));
  }
});

test('o HMAC depende da chave, do e-mail e do código; não é SHA-256 simples nem contém o código', () => {
  const key = deriveVerificationKey('segredo-de-teste-com-mais-de-32-caracteres-0123');
  const other = deriveVerificationKey('outro-segredo-de-teste-com-mais-de-32-caracteres');
  const hash = verificationDigest(key, 'a@example.test', '482913');
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, verificationDigest(key, 'a@example.test', '482913'));
  assert.notEqual(hash, verificationDigest(key, 'b@example.test', '482913'));
  assert.notEqual(hash, verificationDigest(key, 'a@example.test', '482914'));
  assert.notEqual(hash, verificationDigest(other, 'a@example.test', '482913'));
  assert.notEqual(hash, createHash('sha256').update('482913').digest('hex'));
  assert.ok(!hash.includes('482913'));
});

test('a geração não usa Math.random', () => {
  for (const file of ['./verification-code.ts', './account.service.ts']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /Math\.random\s*\(/, file);
  }
});
