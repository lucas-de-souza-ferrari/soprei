import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { CompanyId } from '../../domain/index.js';
import { CredentialDecryptionError } from '../../shared/errors/index.js';
import { SecretString } from '../../shared/types/index.js';
import {
  AesGcmCredentialCipher,
  type CredentialKey,
  parseCredentialKeys,
} from './aes-gcm-credential-cipher.js';

const key = (keyId: string): CredentialKey => ({ keyId, key: randomBytes(32) });
const A = CompanyId.parse(randomUUID());
const B = CompanyId.parse(randomUUID());
const TOKEN = 'EAAG-token-de-teste-bem-secreto-123';

function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof CredentialDecryptionError);
    const everything = `${error.message}${JSON.stringify(error.context)}${JSON.stringify(error)}`;
    assert.ok(!everything.includes(TOKEN));
    return error.reason;
  }
  return assert.fail('deveria lançar');
}

test('roundtrip e IV aleatório', () => {
  const cipher = new AesGcmCredentialCipher([key('k1')], 'k1');
  const one = cipher.encrypt(A, new SecretString(TOKEN));
  const two = cipher.encrypt(A, new SecretString(TOKEN));
  assert.notEqual(one, two);
  assert.ok(!one.includes(TOKEN));
  assert.ok(one.startsWith('v1.k1.'));
  assert.equal(cipher.decrypt(A, one).reveal(), TOKEN);
});

test('chave errada, keyId desconhecido, formato inválido e outra empresa (AAD)', () => {
  const cipher = new AesGcmCredentialCipher([key('k1')], 'k1');
  const stored = cipher.encrypt(A, new SecretString(TOKEN));
  assert.equal(
    reasonOf(() => cipher.decrypt(B, stored)),
    'tampered',
  );
  assert.equal(
    reasonOf(() => new AesGcmCredentialCipher([key('k1')], 'k1').decrypt(A, stored)),
    'tampered',
  );
  assert.equal(
    reasonOf(() => new AesGcmCredentialCipher([key('k2')], 'k2').decrypt(A, stored)),
    'unknown_key',
  );
  for (const bad of ['', 'abc', 'v2.k1.a.b.c', 'v1.k1.a.b', 'v1.k1.AAAA.BBBB.CCCC']) {
    assert.equal(
      reasonOf(() => cipher.decrypt(A, bad)),
      'malformed',
    );
  }
});

test('adulteração de um byte no IV, na tag e no cifrado', () => {
  const cipher = new AesGcmCredentialCipher([key('k1')], 'k1');
  const parts = cipher.encrypt(A, new SecretString(TOKEN)).split('.');
  for (const index of [2, 3, 4]) {
    const raw = Buffer.from(parts[index] ?? '', 'base64url');
    raw[0] = (raw[0] ?? 0) ^ 0xff;
    const changed = [...parts];
    changed[index] = raw.toString('base64url');
    assert.equal(
      reasonOf(() => cipher.decrypt(A, changed.join('.'))),
      'tampered',
    );
  }
});

test('rotação: texto da chave antiga decifra e o novo sai com a ativa', () => {
  const old = key('old');
  const fresh = key('new');
  const before = new AesGcmCredentialCipher([old], 'old').encrypt(A, new SecretString(TOKEN));
  const after = new AesGcmCredentialCipher([fresh, old], 'new');
  assert.equal(after.decrypt(A, before).reveal(), TOKEN);
  assert.ok(after.encrypt(A, new SecretString(TOKEN)).startsWith('v1.new.'));
});

test('parseCredentialKeys: tamanho, repetição, formato; mensagem sem a chave', () => {
  const good = randomBytes(32).toString('base64url');
  assert.ok(parseCredentialKeys(`a:${good},b:${good}`).ok);
  const short = randomBytes(16).toString('base64url');
  for (const raw of [
    `a:${short}`,
    `a:${good},a:${good}`,
    'sem-dois-pontos',
    `a b:${good}`,
    'a:@@@',
  ]) {
    const parsed = parseCredentialKeys(raw);
    assert.ok(!parsed.ok);
    assert.ok(!parsed.message.includes(short) && !parsed.message.includes(good));
  }
});
