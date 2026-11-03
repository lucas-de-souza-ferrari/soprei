import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { isUuid } from './uuid.js';

describe('isUuid', () => {
  it('aceita UUID v4 e v7, em minúsculas e maiúsculas', () => {
    assert.ok(isUuid(randomUUID()));
    assert.ok(isUuid(randomUUID().toUpperCase()));
    assert.ok(isUuid('01890a5d-ac96-774b-bcce-b302099a8057'));
  });

  it('rejeita o que não é UUID', () => {
    for (const value of [
      '',
      'texto',
      '123',
      'zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz',
      '01890a5d-ac96-774b-bcce-b302099a805',
      '01890a5d-ac96-774b-bcce-b302099a80577',
      ' 01890a5d-ac96-774b-bcce-b302099a8057',
      '01890a5dac96774bbcceb302099a8057',
      null,
      undefined,
      42,
    ]) {
      assert.equal(isUuid(value), false, String(value));
    }
  });
});
