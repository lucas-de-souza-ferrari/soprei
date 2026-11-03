import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { ServiceUnavailableError } from '../../shared/errors/index.js';
import { getClosedPort, withPort } from '../../test-support/closed-port.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { TestKeyspace } from '../../test-support/test-keyspace.js';
import { createRedis, type RedisHandle } from '../cache/redis.client.js';
import { createAuthRedis } from './auth-redis.js';
import { RedisAccountSessionStore } from './redis-account-session-store.js';

const config = loadIntegrationConfig();
const keyspace = new TestKeyspace();

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
  const prefix = keyspace.scopedPrefix(`account-session-${randomUUID()}`);
  const handle = createAuthRedis(
    { REDIS_URL: url, AUTH_REDIS_TIMEOUT_MS: 500 },
    captureLogs().logger,
  );
  closers.push(() => handle.close());
  if (url === config.REDIS_URL) assert.ok(await handle.waitUntilReady(5_000));
  return {
    store: new RedisAccountSessionStore(handle.client, prefix),
    prefix,
    client: handle.client,
  };
}

describe('sessões da conta: revogação em massa por geração (spec 021)', () => {
  it('revokeAll derruba as sessões existentes da conta, não as de outra conta, e a sessão nova vale', async () => {
    const { store } = await createStore();
    const a = randomUUID();
    const b = randomUUID();
    const oldA1 = await store.create(a);
    const oldA2 = await store.create(a);
    const otherB = await store.create(b);
    assert.equal((await store.read(oldA1))?.accountId, a);
    await store.revokeAll(a);
    assert.equal(await store.read(oldA1), null);
    assert.equal(await store.read(oldA2), null);
    // `select` numa sessão revogada também é 401.
    await assert.rejects(store.select(oldA2, randomUUID()));
    assert.equal((await store.read(otherB))?.accountId, b);
    const fresh = await store.create(a);
    const session = await store.read(fresh);
    assert.equal(session?.accountId, a);
    assert.equal(session.clientId, null);
    // A seleção de empresa continua funcionando e não perde a geração.
    const clientId = randomUUID();
    await store.select(fresh, clientId);
    assert.equal((await store.read(fresh))?.clientId, clientId);
    // Uma segunda revogação derruba também a sessão criada depois da primeira.
    await store.revokeAll(a);
    assert.equal(await store.read(fresh), null);
    assert.equal((await store.read(otherB))?.accountId, b);
  });

  it('sessão antiga sem o campo gen vale como geração 0 até a primeira revogação', async () => {
    const { store, prefix, client } = await createStore();
    const accountId = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const key = `${prefix}account-session:${createHash('sha256').update(secret).digest('hex')}`;
    const now = Math.floor(Date.now() / 1000);
    await client.set(
      key,
      JSON.stringify({
        accountId,
        id: randomUUID(),
        clientId: null,
        createdAt: now,
        expiresAt: now + 30 * 86400,
      }),
      'EX',
      3600,
    );
    assert.equal((await store.read(secret))?.accountId, accountId);
    await store.revokeAll(accountId);
    assert.equal(await store.read(secret), null);
    // A leitura apagou a chave da sessão revogada.
    assert.equal(await client.exists(key), 0);
  });

  it('a chave da geração tem TTL de 31 dias (maior que o teto de 30 dias da sessão) e só ela cresce', async () => {
    const { store, prefix, client } = await createStore();
    const accountId = randomUUID();
    await store.revokeAll(accountId);
    await store.revokeAll(accountId);
    const key = `${prefix}account-gen:${accountId}`;
    assert.equal(await client.get(key), '2');
    const ttl = await client.ttl(key);
    assert.ok(ttl > 30 * 86400 && ttl <= 31 * 86400, `ttl ${ttl}`);
  });

  it('criar e revogar em paralelo: o que existia antes do revokeAll morre; o criado depois vale', async () => {
    const { store } = await createStore();
    const accountId = randomUUID();
    const before = await Promise.all(Array.from({ length: 10 }, () => store.create(accountId)));
    const racing = Promise.all(Array.from({ length: 10 }, () => store.create(accountId)));
    await store.revokeAll(accountId);
    const raced = await racing;
    for (const secret of before) assert.equal(await store.read(secret), null);
    // Sessões criadas durante a corrida valem ou morrem, nunca ficam em estado inconsistente.
    for (const secret of raced) {
      const session = await store.read(secret);
      assert.ok(session === null || session.accountId === accountId);
    }
    const after = await store.create(accountId);
    assert.equal((await store.read(after))?.accountId, accountId);
  });

  it('Redis fora: revokeAll, create e read falham com 503 (fail-closed)', async () => {
    const down = await createStore(withPort(config.REDIS_URL, await getClosedPort()));
    await assert.rejects(down.store.revokeAll(randomUUID()), ServiceUnavailableError);
    await assert.rejects(down.store.create(randomUUID()), ServiceUnavailableError);
    await assert.rejects(
      down.store.read(randomBytes(32).toString('base64url')),
      ServiceUnavailableError,
    );
  });
});
