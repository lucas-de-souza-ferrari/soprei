import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { keepEventLoopAlive } from '../../test-support/keep-alive.js';
import { TimeoutError, withTimeout } from './timeout.js';

describe('withTimeout', () => {
  it('devolve o valor quando a promise resolve a tempo', async () => {
    assert.equal(await withTimeout(Promise.resolve(42), 100, 'x'), 42);
  });

  it('propaga a rejeição da própria promise (que não é TimeoutError)', async () => {
    const boom = new Error('boom');
    await assert.rejects(
      withTimeout(Promise.reject(boom), 100, 'x'),
      (error: unknown) => error === boom,
    );
  });

  it('rejeita com TimeoutError (mensagem com o rótulo e o prazo) se a promise não resolver', async () => {
    const release = keepEventLoopAlive(); // o timer de withTimeout é unref()
    try {
      await assert.rejects(
        withTimeout(new Promise<never>(() => undefined), 20, 'llm'),
        (error: unknown) => {
          assert.ok(error instanceof TimeoutError);
          assert.ok(error instanceof Error);
          assert.equal(error.timeoutMs, 20);
          assert.equal(error.message, 'llm: sem resposta em 20ms');
          return true;
        },
      );
    } finally {
      release();
    }
  });
});
