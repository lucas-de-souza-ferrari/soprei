import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { ServiceUnavailableError } from '../../shared/errors/index.js';
import { getClosedPort, withPort } from '../../test-support/closed-port.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { TestKeyspace } from '../../test-support/test-keyspace.js';
import { createRedis, type RedisHandle } from '../cache/redis.client.js';
import { createAuthRedis } from './auth-redis.js';
import { RedisPlatformSessionStore } from './redis-platform-session-store.js';

const config = loadIntegrationConfig();
const keyspace = new TestKeyspace();
const FACTOR = 'a'.repeat(32);

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

async function createStore(
  options: { idle?: number; max?: number; url?: string } = {},
): Promise<{ store: RedisPlatformSessionStore; prefix: string }> {
  const url = options.url ?? config.REDIS_URL;
  const prefix = keyspace.scopedPrefix(`platform-session-${randomUUID()}`);
  const handle = createAuthRedis(
    { REDIS_URL: url, AUTH_REDIS_TIMEOUT_MS: 500 },
    captureLogs().logger,
  );
  closers.push(() => handle.close());
  if (url === config.REDIS_URL) assert.ok(await handle.waitUntilReady(5_000));
  return {
    store: new RedisPlatformSessionStore(
      handle.client,
      prefix,
      options.idle ?? 60,
      options.max ?? 600,
    ),
    prefix,
  };
}

/** Sonda até a condição valer ou o prazo acabar (nunca um sleep fixo como asserção). */
async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return check();
}

describe('sessões do admin da plataforma no Redis (spec 044, E1)', () => {
  it('a chave é o SHA-256 do segredo, com TTL, e o valor não contém o segredo', async () => {
    const { store, prefix } = await createStore();
    const adminId = randomUUID();
    const secret = await store.create(adminId, FACTOR);
    assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
    const keys = await main.client.keys(`${prefix}*`);
    const hash = createHash('sha256').update(secret).digest('hex');
    assert.deepEqual(keys, [`${prefix}platform-session:${hash}`]);
    const ttl = await main.client.ttl(keys[0] ?? '');
    assert.ok(ttl > 0 && ttl <= 60, `ttl ${String(ttl)}`);
    const raw = await main.client.get(keys[0] ?? '');
    assert.ok(raw !== null);
    assert.equal(raw.includes(secret), false);
    const session = await store.read(secret);
    assert.ok(session !== null);
    assert.equal(session.adminId, adminId);
    assert.equal(session.factor, FACTOR);
  });

  it('logout apaga; segredo malformado ou desconhecido é null', async () => {
    const { store, prefix } = await createStore();
    const secret = await store.create(randomUUID(), FACTOR);
    await store.revoke(secret);
    assert.equal(await store.read(secret), null);
    assert.deepEqual(await main.client.keys(`${prefix}*`), []);
    await store.revoke(secret);
    assert.equal(await store.read('curto'), null);
    assert.equal(await store.read('x'.repeat(43)), null);
  });

  it('prazo ocioso: sem uso a sessão some; teto absoluto vale mesmo com uso', async () => {
    const idle = await createStore({ idle: 1, max: 600 });
    const lazy = await idle.store.create(randomUUID(), FACTOR);
    assert.ok(await waitFor(async () => (await idle.store.read(lazy)) === null, 5_000));

    const capped = await createStore({ idle: 60, max: 2 });
    const busy = await capped.store.create(randomUUID(), FACTOR);
    assert.notEqual(await capped.store.read(busy), null);
    assert.ok(
      await waitFor(async () => (await capped.store.read(busy)) === null, 6_000),
      'o teto absoluto derruba a sessão mesmo com leituras',
    );
  });

  it('Redis fora: 503 em criar, ler e revogar (fail-closed)', async () => {
    const down = await createStore({ url: withPort(config.REDIS_URL, await getClosedPort()) });
    await assert.rejects(down.store.create(randomUUID(), FACTOR), ServiceUnavailableError);
    await assert.rejects(down.store.read('x'.repeat(43)), ServiceUnavailableError);
    await assert.rejects(down.store.revoke('x'.repeat(43)), ServiceUnavailableError);
  });
});
