import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { adjustmentSchema } from './inventory.schemas.js';

describe('adjustmentSchema: sinal x motivo (S-3)', () => {
  const ok = (delta: number, reason: string) =>
    adjustmentSchema.safeParse({ delta, reason }).success;
  it('ENTRY exige delta positivo; EXIT e LOSS exigem negativo; COUNT_CORRECTION aceita ambos', () => {
    assert.equal(ok(1, 'ENTRY'), true);
    assert.equal(ok(-1, 'ENTRY'), false);
    assert.equal(ok(-1, 'EXIT'), true);
    assert.equal(ok(1, 'EXIT'), false);
    assert.equal(ok(-5, 'LOSS'), true);
    assert.equal(ok(5, 'LOSS'), false);
    assert.equal(ok(3, 'COUNT_CORRECTION'), true);
    assert.equal(ok(-3, 'COUNT_CORRECTION'), true);
    assert.equal(ok(0, 'COUNT_CORRECTION'), false);
  });
});
