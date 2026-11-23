import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { RESUME_ATTEMPT_WINDOW_MS, RESUME_MAX_ATTEMPTS } from '../../domain/index.js';
import { ServiceUnavailableError } from '../../shared/errors/index.js';
import { getClosedPort, withPort } from '../../test-support/closed-port.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { TestKeyspace } from '../../test-support/test-keyspace.js';
import { createRedis, type RedisHandle } from '../cache/redis.client.js';
import { createAuthRedis } from './auth-redis.js';
import { RedisResumeAttemptStore } from './redis-resume-attempts.js';

// Spec 035 (D3): no máximo 3 retomadas por contato em 24 h, no Redis real (/15).
const config = loadIntegrationConfig();
const keyspace = new TestKeyspace();
const CONTACT = '5511987654321';
let main: RedisHandle;
const closers: (() => Promise<void>)[] = [];

before(() => {
  main = createRedis(config, captureLogs().logger);
});

after(async () => {
  for (const close of closers) await close();
  await keyspace.cleanup(main.client);
  await main.close();
});

async function createStore(url: string = config.REDIS_URL) {
  const prefix = keyspace.scopedPrefix(`resume-${randomUUID()}`);
  const handle = createAuthRedis(
    { REDIS_URL: url, AUTH_REDIS_TIMEOUT_MS: 500 },
    captureLogs().logger,
  );
  closers.push(() => handle.close());
  if (url === config.REDIS_URL) assert.ok(await handle.waitUntilReady(5_000));
  return { store: new RedisResumeAttemptStore(handle.client, prefix), prefix };
}

describe('RedisResumeAttemptStore (spec 035)', () => {
  it(`o contato tem ${String(RESUME_MAX_ATTEMPTS)} retomadas; a seguinte recusa; outra empresa e outro contato têm as suas`, async () => {
    const { store } = await createStore();
    const companyA = randomUUID();
    for (let index = 0; index < RESUME_MAX_ATTEMPTS; index += 1) {
      assert.equal(await store.take(companyA, CONTACT), true);
    }
    assert.equal(await store.take(companyA, CONTACT), false);
    assert.equal(await store.take(companyA, CONTACT), false, 'a recusa não muda nada');
    assert.equal(
      await store.take(randomUUID(), CONTACT),
      true,
      'o mesmo telefone em outra empresa',
    );
    assert.equal(await store.take(companyA, '5511900000000'), true, 'outro contato');
  });

  it('a chave tem TTL de 24 h e nunca contém o telefone', async () => {
    const { store, prefix } = await createStore();
    const companyId = randomUUID();
    await store.take(companyId, CONTACT);
    const keys = await keyspace.keysUnder(main.client, prefix);
    assert.equal(keys.length, 1);
    const [key] = keys;
    assert.ok(key !== undefined);
    assert.ok(!key.includes(CONTACT), 'sem o telefone na chave');
    assert.ok(key.includes(companyId), 'a chave deriva da empresa');
    const ttl = await main.client.ttl(key);
    assert.ok(ttl > 0 && ttl <= RESUME_ATTEMPT_WINDOW_MS / 1000, `TTL ${String(ttl)}`);
  });

  it('Redis fora: lança ServiceUnavailableError sem anexar o erro do ioredis', async () => {
    const port = await getClosedPort();
    const { store } = await createStore(withPort(config.REDIS_URL, port));
    await assert.rejects(store.take(randomUUID(), CONTACT), (error: unknown) => {
      assert.ok(error instanceof ServiceUnavailableError);
      assert.equal(error.cause, undefined);
      return true;
    });
  });
});
