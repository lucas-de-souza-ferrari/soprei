import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { SALES_CONTACT_DAILY_CAP } from '../../domain/index.js';
import { ServiceUnavailableError } from '../../shared/errors/index.js';
import { getClosedPort, withPort } from '../../test-support/closed-port.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { TestKeyspace } from '../../test-support/test-keyspace.js';
import { createRedis, type RedisHandle } from '../cache/redis.client.js';
import { createAuthRedis } from './auth-redis.js';
import { RedisSalesContactCap } from './redis-sales-contact-cap.js';

// Spec 040 (E4): teto global diário do contato comercial no Redis real (/15), prefixo único por teste.
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

async function createCap(url: string = config.REDIS_URL) {
  const prefix = keyspace.scopedPrefix(`sales-contact-${randomUUID()}`);
  const handle = createAuthRedis(
    { REDIS_URL: url, AUTH_REDIS_TIMEOUT_MS: 500 },
    captureLogs().logger,
  );
  closers.push(() => handle.close());
  if (url === config.REDIS_URL) assert.ok(await handle.waitUntilReady(5_000));
  return { cap: new RedisSalesContactCap(handle.client, prefix), prefix };
}

describe('teto diário do contato comercial (spec 040, D13)', () => {
  it('30 por dia: o 31º é recusado; outro dia tem contador próprio; chave com TTL de até 48 h', async () => {
    const { cap, prefix } = await createCap();
    for (let index = 0; index < SALES_CONTACT_DAILY_CAP; index += 1) {
      assert.equal(await cap.take('2026-11-13'), true, `envio ${String(index + 1)}`);
    }
    assert.equal(await cap.take('2026-11-13'), false);
    assert.equal(await cap.take('2026-11-14'), true);
    const key = `${prefix}sales-contact:day:2026-11-13`;
    const ttl = await main.client.ttl(key);
    assert.ok(ttl > 47 * 3_600 && ttl <= 48 * 3_600, `TTL ${String(ttl)}`);
    assert.equal(Number(await main.client.get(key)), SALES_CONTACT_DAILY_CAP + 1);
  });

  it('dia malformado nunca vira chave', async () => {
    const { cap } = await createCap();
    await assert.rejects(cap.take('2026-11-13:x'), RangeError);
  });

  it('Redis fora: ServiceUnavailableError sem o erro do ioredis anexado', async () => {
    const dead = withPort(config.REDIS_URL, await getClosedPort());
    const { cap } = await createCap(dead);
    await assert.rejects(cap.take('2026-11-13'), (error: unknown) => {
      assert.ok(error instanceof ServiceUnavailableError);
      assert.equal(error.cause, undefined);
      return true;
    });
  });
});
