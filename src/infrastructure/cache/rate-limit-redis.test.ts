import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, it } from 'node:test';
import type { Redis } from 'ioredis';
import { observeStoreErrors } from './rate-limit-redis.js';

type Callback = (error: Error | null, result?: unknown) => void;

/** Client de mentira com o mesmo contrato do ioredis para `defineCommand` e scripts. */
class FakeClient {
  readonly defined: string[] = [];
  behavior: 'ok' | 'error' | 'throw' = 'ok';
  /** Faz o callback rodar fora do contexto assíncrono de quem chamou (como um socket faz). */
  detach = false;

  defineCommand(name: string): void {
    this.defined.push(name);
    (this as unknown as Record<string, unknown>)[name] = (...args: unknown[]): void => {
      const callback = args.at(-1) as Callback;
      if (this.behavior === 'throw') throw new Error('falha síncrona');
      const run = (): void => {
        if (this.behavior === 'error') callback(new Error('Command timed out'));
        else callback(null, [1, 1000]);
      };
      if (this.detach) setImmediate(run);
      else run();
    };
  }
}

function setup(): {
  client: FakeClient;
  errors: Error[];
  store: ReturnType<typeof observeStoreErrors>;
} {
  const client = new FakeClient();
  const errors: Error[] = [];
  const store = observeStoreErrors(client as unknown as Redis, (error) => {
    errors.push(error);
  });
  store.defineCommand('rateLimit', { numberOfKeys: 1, lua: 'return 1' });
  return { client, errors, store };
}

function call(
  store: ReturnType<typeof observeStoreErrors>,
): Promise<{ error: Error | null; result?: unknown }> {
  return new Promise((resolve) => {
    const command = store.rateLimit;
    assert.ok(command, 'comando definido');
    command('chave', 1000, 5, false, false, (error: Error | null, result?: unknown) => {
      resolve({ error, result });
    });
  });
}

describe('observeStoreErrors', () => {
  it('só passa a existir o comando depois de defineCommand, que vai ao client real', () => {
    const client = new FakeClient();
    const store = observeStoreErrors(client as unknown as Redis, () => undefined);
    assert.equal(store.rateLimit, undefined);
    store.defineCommand('rateLimit', { numberOfKeys: 1, lua: 'x' });
    assert.deepEqual(client.defined, ['rateLimit']);
    assert.equal(typeof store.rateLimit, 'function');
  });

  it('sucesso: devolve o resultado do client e não avisa erro', async () => {
    const { errors, store } = setup();
    const { error, result } = await call(store);
    assert.equal(error, null);
    assert.deepEqual(result, [1, 1000]);
    assert.deepEqual(errors, []);
  });

  it('falha do comando: avisa o observador e repassa o erro ao plugin', async () => {
    const { client, errors, store } = setup();
    client.behavior = 'error';
    const { error } = await call(store);
    assert.match(error?.message ?? '', /Command timed out/);
    assert.equal(errors.length, 1);
    assert.match(errors[0]?.message ?? '', /Command timed out/);
  });

  it('exceção síncrona do client vira erro no callback, nunca lança', async () => {
    const { client, errors, store } = setup();
    client.behavior = 'throw';
    const { error } = await call(store);
    assert.match(error?.message ?? '', /falha síncrona/);
    assert.equal(errors.length, 1);
  });

  it('o aviso de erro roda no contexto assíncrono de quem chamou (herda o requestId do log)', async () => {
    const als = new AsyncLocalStorage<string>();
    const client = new FakeClient();
    client.behavior = 'error';
    client.detach = true;
    let seen: string | undefined;
    const store = observeStoreErrors(client as unknown as Redis, () => {
      seen = als.getStore();
    });
    store.defineCommand('rateLimit', { numberOfKeys: 1, lua: 'x' });
    await als.run('req-123', () => call(store));
    assert.equal(seen, 'req-123');
  });
});
