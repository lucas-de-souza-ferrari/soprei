import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Result } from './result.js';

describe('Result', () => {
  it('ok carrega o valor', () => {
    const result = Result.ok(42);
    assert.deepEqual(result, { ok: true, value: 42 });
  });

  it('err carrega o erro', () => {
    const error = new Error('falhou');
    const result = Result.err(error);
    assert.equal(result.ok, false);
    assert.equal(result.error, error);
  });

  it('from converte promise resolvida em ok', async () => {
    const result = await Result.from(Promise.resolve('valor'));
    assert.deepEqual(result, { ok: true, value: 'valor' });
  });

  it('from converte promise rejeitada em err sem lançar', async () => {
    const cause = new Error('rejeitada');
    const result = await Result.from(Promise.reject(cause));
    assert.equal(result.ok, false);
    assert.equal(result.error, cause);
  });

  it('from normaliza rejeição que não é Error', async () => {
    // Bibliotecas de terceiros às vezes rejeitam com valores que não são Error: caso deliberado.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const result = await Result.from(Promise.reject('texto'));
    assert.equal(result.ok, false);
    assert.ok(result.error instanceof Error);
    assert.equal(result.error.message, 'texto');
  });
});
