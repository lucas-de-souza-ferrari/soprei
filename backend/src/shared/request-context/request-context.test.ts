import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createRequestContext,
  getContext,
  runWithContext,
  setClientId,
  setOperation,
  setUserId,
} from './index.js';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe('request-context', () => {
  it('fora de uma requisição, getContext devolve undefined e os setters são no-op', () => {
    assert.equal(getContext(), undefined);
    assert.doesNotThrow(() => {
      setClientId('c1');
      setUserId('u1');
      setOperation('GET /x');
    });
    assert.equal(getContext(), undefined);
  });

  it('os setters alteram o contexto da requisição atual', () => {
    runWithContext(createRequestContext('req-1'), () => {
      assert.deepEqual({ ...getContext() }, { requestId: 'req-1' });
      setClientId('c1');
      setUserId('u1');
      setOperation('GET /x');
      assert.deepEqual(
        { ...getContext() },
        { requestId: 'req-1', clientId: 'c1', userId: 'u1', operation: 'GET /x' },
      );
    });
    assert.equal(getContext(), undefined);
  });

  it('o contexto sobrevive a await e é isolado entre execuções concorrentes', async () => {
    const seen: string[] = [];
    const run = (id: string, delay: number): Promise<void> =>
      Promise.resolve(
        runWithContext(createRequestContext(id), async () => {
          setClientId(`client-${id}`);
          await sleep(delay);
          seen.push(`${id}:${getContext()?.clientId ?? '?'}`);
          await sleep(delay);
          seen.push(`${id}:${getContext()?.requestId ?? '?'}`);
        }),
      );
    await Promise.all([run('a', 20), run('b', 5)]);
    assert.deepEqual([...seen].sort(), ['a:a', 'a:client-a', 'b:b', 'b:client-b']);
  });
});
