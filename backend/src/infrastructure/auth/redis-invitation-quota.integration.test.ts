import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  INVITATION_ACCOUNT_SENDS_PER_DAY,
  INVITATION_RECIPIENT_EMAILS_PER_DAY,
} from '../../domain/index.js';
import { ServiceUnavailableError } from '../../shared/errors/index.js';
import { getClosedPort, withPort } from '../../test-support/closed-port.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { TestKeyspace } from '../../test-support/test-keyspace.js';
import { createRedis, type RedisHandle } from '../cache/redis.client.js';
import { createAuthRedis } from './auth-redis.js';
import { RedisInvitationQuotaStore } from './redis-invitation-quota.js';

// Spec 025: cotas por destinatário e por conta convidadora, entre empresas, no Redis real (/15).
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
  const prefix = keyspace.scopedPrefix(`invite-quota-${randomUUID()}`);
  const handle = createAuthRedis(
    { REDIS_URL: url, AUTH_REDIS_TIMEOUT_MS: 500 },
    captureLogs().logger,
  );
  closers.push(() => handle.close());
  if (url === config.REDIS_URL) assert.ok(await handle.waitUntilReady(5_000));
  return {
    store: new RedisInvitationQuotaStore(handle.client, prefix),
    prefix,
    client: handle.client,
  };
}

const digest = (): string => randomBytes(32).toString('hex');

describe('cotas do e-mail de convite (spec 025)', () => {
  it('o destinatário recebe no máximo 3 e-mails por dia e o 4º é recusado sem consumir a conta convidadora', async () => {
    const { store, client, prefix } = await createStore();
    const recipient = digest();
    const account = digest();
    for (let index = 0; index < INVITATION_RECIPIENT_EMAILS_PER_DAY; index += 1) {
      assert.equal(await store.take(recipient, account), true, `envio ${String(index + 1)}`);
    }
    assert.equal(await store.take(recipient, account), false);
    // A conta convidadora gastou só as 3 vagas dos envios aceitos (tudo ou nada).
    assert.equal(
      Number(await client.get(`${prefix}invite-quota:account:${account}`)),
      INVITATION_RECIPIENT_EMAILS_PER_DAY,
    );
  });

  it('a conta convidadora tem teto de 50 por dia, somando destinatários diferentes', async () => {
    const { store } = await createStore();
    const account = digest();
    for (let index = 0; index < INVITATION_ACCOUNT_SENDS_PER_DAY; index += 1) {
      assert.equal(await store.take(digest(), account), true, `envio ${String(index + 1)}`);
    }
    assert.equal(await store.take(digest(), account), false);
    // Outra conta convidadora não é afetada.
    assert.equal(await store.take(digest(), digest()), true);
  });

  it('sem conta convidadora (vínculo legado), só vale a cota do destinatário', async () => {
    const { store } = await createStore();
    const recipient = digest();
    for (let index = 0; index < INVITATION_RECIPIENT_EMAILS_PER_DAY; index += 1) {
      assert.equal(await store.take(recipient, null), true);
    }
    assert.equal(await store.take(recipient, null), false);
  });

  it('toda chave tem TTL de até 24 h e só guarda HMAC (nenhum e-mail nem id em claro)', async () => {
    const { store, client, prefix } = await createStore();
    const recipient = digest();
    const account = digest();
    await store.take(recipient, account);
    const keys = await keyspace.keysUnder(client, prefix);
    assert.equal(keys.length, 2);
    for (const key of keys) {
      const ttl = await client.ttl(key);
      assert.ok(ttl > 0 && ttl <= 24 * 3600, `ttl ${String(ttl)}`);
      assert.ok(!key.includes('@'));
    }
  });

  it('concorrência: 40 pedidos simultâneos ao mesmo destinatário aprovam exatamente 3', async () => {
    const { store } = await createStore();
    const recipient = digest();
    const account = digest();
    const results = await Promise.all(
      Array.from({ length: 40 }, () => store.take(recipient, account)),
    );
    assert.equal(results.filter(Boolean).length, INVITATION_RECIPIENT_EMAILS_PER_DAY);
  });

  it('Redis fora é ServiceUnavailableError (fail-closed), sem eco do erro do ioredis', async () => {
    const dead = withPort(config.REDIS_URL, await getClosedPort());
    const { store } = await createStore(dead);
    await assert.rejects(store.ping(), (error: unknown) => {
      assert.ok(error instanceof ServiceUnavailableError);
      assert.equal(error.cause, undefined);
      return true;
    });
    await assert.rejects(store.take(digest(), digest()), ServiceUnavailableError);
    // Com o Redis no ar, o ping passa.
    const live = await createStore();
    await live.store.ping();
  });
});
