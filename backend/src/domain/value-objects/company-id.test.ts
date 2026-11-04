import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { ValidationError } from '../../shared/errors/index.js';
import { CompanyId } from './company-id.js';

describe('CompanyId.parse', () => {
  it('aceita UUID válido e devolve o mesmo valor', () => {
    const id = randomUUID();
    assert.equal(CompanyId.parse(id), id);
  });

  it('normaliza para minúsculas', () => {
    const id = randomUUID();
    assert.equal(CompanyId.parse(id.toUpperCase()), id);
  });

  for (const [label, value] of [
    ['string vazia', ''],
    ['texto', 'empresa-a'],
    ['número', '12345'],
    ['UUID malformado (curto)', '01890a5d-ac96-774b-bcce-b302099a805'],
    ['UUID malformado (caractere inválido)', 'zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz'],
    ['UUID com espaço', ` ${randomUUID()}`],
  ] as const) {
    it(`rejeita ${label} com ValidationError`, () => {
      assert.throws(
        () => CompanyId.parse(value),
        (error: unknown) => error instanceof ValidationError && error.statusCode === 400,
      );
    });
  }
});
