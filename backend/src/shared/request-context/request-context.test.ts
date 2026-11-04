import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createRequestContext,
  getContext,
  runWithContext,
  setCompanyId,
  setOperation,
  setActorId,
} from './index.js';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe('request-context', () => {
  it('fora de uma requisição, getContext devolve undefined e os setters são no-op', () => {
    assert.equal(getContext(), undefined);
    assert.doesNotThrow(() => {
      setCompanyId('c1');
      setActorId('u1');
      setOperation('GET /x');
    });
    assert.equal(getContext(), undefined);
  });

  it('os setters alteram o contexto da requisição atual', () => {
    runWithContext(createRequestContext('req-1'), () => {
      assert.deepEqual({ ...getContext() }, { requestId: 'req-1' });
      setCompanyId('c1');
      setActorId('u1');
      setOperation('GET /x');
      assert.deepEqual(
        { ...getContext() },
        { requestId: 'req-1', companyId: 'c1', actorId: 'u1', operation: 'GET /x' },
      );
    });
    assert.equal(getContext(), undefined);
  });

  it('o contexto sobrevive a await e é isolado entre execuções concorrentes', async () => {
    const seen: string[] = [];
    const run = (id: string, delay: number): Promise<void> =>
      Promise.resolve(
        runWithContext(createRequestContext(id), async () => {
          setCompanyId(`company-${id}`);
          await sleep(delay);
          seen.push(`${id}:${getContext()?.companyId ?? '?'}`);
          await sleep(delay);
          seen.push(`${id}:${getContext()?.requestId ?? '?'}`);
        }),
      );
    await Promise.all([run('a', 20), run('b', 5)]);
    assert.deepEqual([...seen].sort(), ['a:a', 'a:company-a', 'b:b', 'b:company-b']);
  });
});
