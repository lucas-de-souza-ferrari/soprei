import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  type CompanyId,
  CompanyId as CompanyIdFactory,
  SCHEDULE_AI_COMPANY_MAX_WRITES_PER_DAY,
  SCHEDULE_AI_CONTACT_MAX_WRITES_PER_DAY,
} from '../../domain/index.js';
import { ServiceUnavailableError } from '../../shared/errors/index.js';
import { getClosedPort, withPort } from '../../test-support/closed-port.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { TestKeyspace } from '../../test-support/test-keyspace.js';
import { createRedis, type RedisHandle } from '../cache/redis.client.js';
import { createAuthRedis } from './auth-redis.js';
import { RedisScheduleAiQuotaStore } from './redis-schedule-ai-quota.js';

// Spec 028: cotas de escrita da IA por contato (8) e por empresa (100) em 24 h, no Redis real (/15).
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
  const prefix = keyspace.scopedPrefix(`sched-quota-${randomUUID()}`);
  const handle = createAuthRedis(
    { REDIS_URL: url, AUTH_REDIS_TIMEOUT_MS: 500 },
    captureLogs().logger,
  );
  closers.push(() => handle.close());
  if (url === config.REDIS_URL) assert.ok(await handle.waitUntilReady(5_000));
  return { store: new RedisScheduleAiQuotaStore(handle.client, prefix), prefix };
}

const company = (): CompanyId => CompanyIdFactory.parse(randomUUID());
const key = (): string => randomBytes(32).toString('hex');

describe('RedisScheduleAiQuotaStore (spec 028)', () => {
  it('o contato tem 8 escritas por dia; a 9ª recusa e nada mais é consumido', async () => {
    const { store } = await createStore();
    const companyId = company();
    const contact = key();
    for (let index = 0; index < SCHEDULE_AI_CONTACT_MAX_WRITES_PER_DAY; index += 1) {
      assert.equal(await store.take(companyId, contact), 'ok');
    }
    assert.equal(await store.take(companyId, contact), 'contact_limit');
    // Outro contato da mesma empresa ainda tem cota; a recusa não consumiu a da empresa.
    assert.equal(await store.take(companyId, key()), 'ok');
  });

  it('a empresa tem 100 escritas por dia: a 101ª recusa, mesmo com contatos diferentes', async () => {
    const { store } = await createStore();
    const companyId = company();
    for (let index = 0; index < SCHEDULE_AI_COMPANY_MAX_WRITES_PER_DAY; index += 1) {
      assert.equal(await store.take(companyId, key()), 'ok');
    }
    assert.equal(await store.take(companyId, key()), 'company_limit');
    // Outra empresa não é afetada.
    assert.equal(await store.take(company(), key()), 'ok');
  });

  it('as chaves têm TTL de 24 h e nunca guardam o contato em claro', async () => {
    const { store, prefix } = await createStore();
    const companyId = company();
    await store.take(companyId, 'a'.repeat(64));
    const keys = await keyspace.keysUnder(main.client, prefix);
    assert.equal(keys.length, 2);
    for (const redisKey of keys) {
      const ttl = await main.client.ttl(redisKey);
      assert.ok(ttl > 0 && ttl <= 86_400, `ttl ${String(ttl)}`);
    }
    assert.ok(keys.some((item) => item.includes(companyId)));
  });

  it('Redis fora: ping e take lançam ServiceUnavailableError sem anexar o erro do driver', async () => {
    const port = await getClosedPort();
    const { store } = await createStore(withPort(config.REDIS_URL, port));
    await assert.rejects(store.ping(), (error: unknown) => {
      assert.ok(error instanceof ServiceUnavailableError);
      assert.equal(error.cause, undefined);
      return true;
    });
    await assert.rejects(store.take(company(), key()), ServiceUnavailableError);
  });
});
