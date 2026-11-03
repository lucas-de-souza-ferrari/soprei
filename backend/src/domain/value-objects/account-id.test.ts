import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AccountId } from './user-id.js';
import { ValidationError } from '../../shared/errors/index.js';

test('AccountId valida UUID e normaliza caixa, sem aceitar identificador externo', () => {
  assert.equal(
    AccountId.parse('55E5AB1E-37F6-4A9B-ABDC-A86D1DC088E4'),
    '55e5ab1e-37f6-4a9b-abdc-a86d1dc088e4',
  );
  for (const value of ['', 'email@example.test', 'cliente-a'])
    assert.throws(() => AccountId.parse(value), ValidationError);
});
