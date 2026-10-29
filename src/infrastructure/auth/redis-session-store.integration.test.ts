import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { Redis } from 'ioredis';
import { ServiceUnavailableError } from '../../shared/errors/index.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { TestKeyspace } from '../../test-support/test-keyspace.js';
import { ToggleProxy } from '../../test-support/toggle-proxy.js';
import { createRedis, type RedisHandle } from '../cache/redis.client.js';
import { createAuthRedis } from './auth-redis.js';
import { RedisSessionStore, type RedisSessionStoreOptions } from './redis-session-store.js';

const config = loadIntegrationConfig();
const keyspace = new TestKeyspace();
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
const newHash = (): string => sha(randomBytes(32).toString('hex'));
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

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

interface Env {
  readonly store: RedisSessionStore;
  readonly prefix: string;
  keys(): Promise<string[]>;
}

async function createStore(
  overrides: Partial<RedisSessionStoreOptions> = {},
  url: string = config.REDIS_URL,
): Promise<Env> {
  const logs = captureLogs();
  const prefix = keyspace.scopedPrefix(`auth-${randomUUID()}`);
  const handle = createAuthRedis({ REDIS_URL: url, AUTH_REDIS_TIMEOUT_MS: 500 }, logs.logger);
  closers.push(() => handle.close());
  assert.ok(await handle.waitUntilReady(5_000), 'conexão de auth não ficou pronta');
  const store = new RedisSessionStore({
    client: handle.client,
    logger: logs.logger,
    prefix,
    idleTtlSeconds: 3_600,
    maxSeconds: 7_200,
    accessTtlSeconds: 900,
    loginMaxFailures: 3,
    loginLockSeconds: 900,
    ...overrides,
  });
  return { store, prefix, keys: () => keyspace.keysUnder(main.client, prefix) };
}

const scope = (): string => randomUUID();

/** Todo valor de todas as chaves do prefixo, em texto (para procurar o que não pode estar lá). */
async function dumpValues(redis: Redis, keys: readonly string[]): Promise<string> {
  const parts: string[] = [];
  for (const key of keys) {
    const type = await redis.type(key);
    parts.push(key);
    if (type === 'string') parts.push((await redis.get(key)) ?? '');
    else if (type === 'hash') parts.push(JSON.stringify(await redis.hgetall(key)));
    else if (type === 'list') parts.push((await redis.lrange(key, 0, -1)).join(' '));
    else if (type === 'set') parts.push((await redis.smembers(key)).join(' '));
  }
  return parts.join('\n');
}

describe('RedisSessionStore: rotação, reuso e revogação (Redis real)', () => {
  it('rotaciona, o hash antigo vira reuso e a sessão cai (refresh novo e access também)', async () => {
    const { store } = await createStore();
    const [cid, sid, uid] = [scope(), randomUUID(), randomUUID()];
    const h1 = newHash();
    const h2 = newHash();
    const h3 = newHash();
    await store.createSession({ scope: cid, sessionId: sid, subjectId: uid, refreshHash: h1 });
    assert.deepEqual(
      await store.rotate({ scope: cid, sessionId: sid, presentedHash: h1, newHash: h2 }),
      {
        status: 'rotated',
        subjectId: uid,
      },
    );
    assert.deepEqual(
      await store.rotate({ scope: cid, sessionId: sid, presentedHash: h1, newHash: h3 }),
      {
        status: 'reuse',
        subjectId: uid,
      },
    );
    assert.deepEqual(
      await store.rotate({ scope: cid, sessionId: sid, presentedHash: h2, newHash: h3 }),
      {
        status: 'invalid',
      },
    );
    assert.equal(
      await store.checkAccess({ scope: cid, sessionId: sid, subjectId: uid, issuedAt: 1 }),
      'revoked',
    );
  });

  it('hash desconhecido é inválido e NÃO revoga a sessão', async () => {
    const { store } = await createStore();
    const [cid, sid, uid] = [scope(), randomUUID(), randomUUID()];
    const h1 = newHash();
    await store.createSession({ scope: cid, sessionId: sid, subjectId: uid, refreshHash: h1 });
    assert.deepEqual(
      await store.rotate({
        scope: cid,
        sessionId: sid,
        presentedHash: newHash(),
        newHash: newHash(),
      }),
      { status: 'invalid' },
    );
    assert.equal(
      await store.checkAccess({ scope: cid, sessionId: sid, subjectId: uid, issuedAt: 1 }),
      'ok',
    );
    assert.equal(
      (await store.rotate({ scope: cid, sessionId: sid, presentedHash: h1, newHash: newHash() }))
        .status,
      'rotated',
    );
  });

  it('chamadas simultâneas com o mesmo refresh: no máximo uma rotação, as outras são reuso', async () => {
    const { store } = await createStore();
    for (let round = 0; round < 10; round += 1) {
      const [cid, sid, uid] = [scope(), randomUUID(), randomUUID()];
      const h1 = newHash();
      await store.createSession({ scope: cid, sessionId: sid, subjectId: uid, refreshHash: h1 });
      const outcomes = await Promise.all(
        Array.from({ length: 6 }, () =>
          store.rotate({ scope: cid, sessionId: sid, presentedHash: h1, newHash: newHash() }),
        ),
      );
      const rotated = outcomes.filter((outcome) => outcome.status === 'rotated');
      assert.equal(rotated.length, 1, `rodada ${String(round)}: exatamente uma rotação`);
      // As demais chegaram depois da rotação: reuso (ou inválido, se a sessão já tinha caído).
      for (const outcome of outcomes) assert.notEqual(outcome.status, undefined);
      assert.equal(outcomes.filter((outcome) => outcome.status === 'reuse').length >= 1, true);
      assert.equal(
        await store.checkAccess({ scope: cid, sessionId: sid, subjectId: uid, issuedAt: 1 }),
        'revoked',
        'o reuso derrubou a sessão',
      );
    }
  });

  it('o refresh adulterado (escopo de outro cliente) não toca em sessão alguma', async () => {
    const { store } = await createStore();
    const [clientA, clientB, sidA, sidB, userA, userB] = [
      scope(),
      scope(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    const hashA = newHash();
    const hashB = newHash();
    await store.createSession({
      scope: clientA,
      sessionId: sidA,
      subjectId: userA,
      refreshHash: hashA,
    });
    await store.createSession({
      scope: clientB,
      sessionId: sidB,
      subjectId: userB,
      refreshHash: hashB,
    });
    for (const attempt of [
      { scope: clientB, sessionId: sidA, presentedHash: hashA },
      { scope: clientA, sessionId: sidB, presentedHash: hashB },
      { scope: 'platform', sessionId: sidA, presentedHash: hashA },
    ]) {
      assert.deepEqual(await store.rotate({ ...attempt, newHash: newHash() }), {
        status: 'invalid',
      });
      assert.equal(await store.revokeByRefresh(attempt), false);
    }
    for (const [s, sid, u, h] of [
      [clientA, sidA, userA, hashA],
      [clientB, sidB, userB, hashB],
    ] as const) {
      assert.equal(
        await store.checkAccess({ scope: s, sessionId: sid, subjectId: u, issuedAt: 1 }),
        'ok',
      );
      assert.equal(
        (await store.rotate({ scope: s, sessionId: sid, presentedHash: h, newHash: newHash() }))
          .status,
        'rotated',
      );
    }
  });

  it('revokeByRefresh só revoga com o hash vigente ou um já usado; é idempotente', async () => {
    const { store } = await createStore();
    const [cid, sid, uid] = [scope(), randomUUID(), randomUUID()];
    const h1 = newHash();
    await store.createSession({ scope: cid, sessionId: sid, subjectId: uid, refreshHash: h1 });
    assert.equal(
      await store.revokeByRefresh({ scope: cid, sessionId: sid, presentedHash: newHash() }),
      false,
    );
    assert.equal(
      await store.checkAccess({ scope: cid, sessionId: sid, subjectId: uid, issuedAt: 1 }),
      'ok',
    );
    assert.equal(
      await store.revokeByRefresh({ scope: cid, sessionId: sid, presentedHash: h1 }),
      true,
    );
    assert.equal(
      await store.checkAccess({ scope: cid, sessionId: sid, subjectId: uid, issuedAt: 1 }),
      'revoked',
    );
    assert.equal(
      await store.revokeByRefresh({ scope: cid, sessionId: sid, presentedHash: h1 }),
      true,
    );
    assert.equal(
      await store.revokeByRefresh({ scope: cid, sessionId: randomUUID(), presentedHash: h1 }),
      false,
    );
  });

  it('logout-all revoga as sessões e corta os access tokens (nbf) do usuário, sem afetar outro usuário nem cliente', async () => {
    const t0 = Date.UTC(2026, 5, 1, 12, 0, 0);
    let clock = t0;
    const { store } = await createStore({ now: () => new Date(clock) });
    const [clientA, clientB, userA, userA2, userB] = [
      scope(),
      scope(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    const sessions = [
      { scope: clientA, sid: randomUUID(), user: userA },
      { scope: clientA, sid: randomUUID(), user: userA },
      { scope: clientA, sid: randomUUID(), user: userA2 },
      { scope: clientB, sid: randomUUID(), user: userB },
    ];
    const hashes = sessions.map(() => newHash());
    for (const [index, session] of sessions.entries()) {
      await store.createSession({
        scope: session.scope,
        sessionId: session.sid,
        subjectId: session.user,
        refreshHash: hashes[index] ?? '',
      });
    }
    const iat = Math.floor(t0 / 1000);
    clock += 5_000;
    await store.revokeAllSessions(clientA, userA);
    const check = (index: number, issuedAt = iat) => {
      const session = sessions[index];
      assert.ok(session);
      return store.checkAccess({
        scope: session.scope,
        sessionId: session.sid,
        subjectId: session.user,
        issuedAt,
      });
    };
    assert.equal(await check(0), 'revoked');
    assert.equal(await check(1), 'revoked');
    assert.equal(await check(2), 'ok');
    assert.equal(await check(3), 'ok');
    // Um token novo (iat depois do nbf) de uma sessão nova do mesmo usuário vale.
    const fresh = randomUUID();
    await store.createSession({
      scope: clientA,
      sessionId: fresh,
      subjectId: userA,
      refreshHash: newHash(),
    });
    assert.equal(
      await store.checkAccess({
        scope: clientA,
        sessionId: fresh,
        subjectId: userA,
        issuedAt: iat + 5,
      }),
      'ok',
    );
    assert.equal(
      await store.checkAccess({
        scope: clientA,
        sessionId: fresh,
        subjectId: userA,
        issuedAt: iat + 4,
      }),
      'revoked',
      'iat anterior ao nbf cai mesmo numa sessão sem marca de revogação',
    );
    // Os refresh das sessões revogadas falham; os do outro usuário e do outro cliente continuam.
    for (const index of [0, 1]) {
      const session = sessions[index];
      assert.ok(session);
      assert.equal(
        (
          await store.rotate({
            scope: session.scope,
            sessionId: session.sid,
            presentedHash: hashes[index] ?? '',
            newHash: newHash(),
          })
        ).status,
        'invalid',
      );
    }
    for (const index of [2, 3]) {
      const session = sessions[index];
      assert.ok(session);
      assert.equal(
        (
          await store.rotate({
            scope: session.scope,
            sessionId: session.sid,
            presentedHash: hashes[index] ?? '',
            newHash: newHash(),
          })
        ).status,
        'rotated',
      );
    }
  });
});

describe('RedisSessionStore: chaves, TTL e o que fica no Redis', () => {
  it('toda chave criada tem TTL e o relógio dos prazos é o do Redis (idle e teto absoluto)', async () => {
    const env = await createStore({
      idleTtlSeconds: 3_600,
      maxSeconds: 7_200,
      accessTtlSeconds: 900,
    });
    const { store } = env;
    const [cid, sid, uid] = [scope(), randomUUID(), randomUUID()];
    const h1 = newHash();
    await store.createSession({ scope: cid, sessionId: sid, subjectId: uid, refreshHash: h1 });
    await store.rotate({ scope: cid, sessionId: sid, presentedHash: h1, newHash: newHash() });
    await store.revokeAllSessions(cid, uid);
    await store.recordLoginFailure(sha('qualquer'));
    const keys = await env.keys();
    assert.ok(keys.length >= 5, `chaves: ${String(keys.length)}`);
    for (const key of keys) {
      const ttl = await main.client.ttl(key);
      assert.ok(ttl > 0, `${key.slice(-30)} sem TTL (${String(ttl)})`);
      assert.ok(ttl <= 7_200, `${key.slice(-30)} com TTL acima do teto (${String(ttl)})`);
    }
    // sess: o menor entre o ocioso e o teto; used: o mesmo; usess: o teto; rsid/nbf: o do access token.
    const sessKey = keys.find((key) => key.endsWith(`:sess:${sid}`));
    assert.ok(sessKey);
    assert.ok((await main.client.ttl(sessKey)) <= 3_600);
    const rsid = keys.find((key) => key.includes(':rsid:'));
    // A sessão não foi revogada individualmente; o `nbf` do usuário tem o TTL do access token.
    const nbf = keys.find((key) => key.endsWith(`:nbf:${uid}`));
    assert.ok(nbf);
    assert.ok((await main.client.ttl(nbf)) <= 900);
    assert.equal(rsid === undefined || (await main.client.ttl(rsid)) <= 900, true);
  });

  it('o prazo ocioso é renovado a cada rotação, sem passar do que resta do teto absoluto', async () => {
    const env = await createStore({ idleTtlSeconds: 3_600, maxSeconds: 7_200 });
    const { store } = env;
    const [cid, sid, uid] = [scope(), randomUUID(), randomUUID()];
    let current = newHash();
    await store.createSession({ scope: cid, sessionId: sid, subjectId: uid, refreshHash: current });
    const sessKey = `${env.prefix}${cid}:sess:${sid}`;
    const usedKey = `${env.prefix}${cid}:used:${sid}`;

    // Ocioso: encurta o TTL à mão e a rotação o devolve ao prazo ocioso (renovação).
    await main.client.expire(sessKey, 30);
    const next = newHash();
    await store.rotate({ scope: cid, sessionId: sid, presentedHash: current, newHash: next });
    current = next;
    const renewed = await main.client.ttl(sessKey);
    assert.ok(renewed > 3_000 && renewed <= 3_600, `renovado para ${String(renewed)} s`);
    assert.ok((await main.client.ttl(usedKey)) > 3_000);

    // Teto absoluto: com 40 s para o fim do teto, a rotação não passa disso.
    const redisNow = Number((await main.client.time())[0]);
    await main.client.hset(sessKey, 'maxAt', redisNow + 40);
    await store.rotate({ scope: cid, sessionId: sid, presentedHash: current, newHash: newHash() });
    const capped = await main.client.ttl(sessKey);
    assert.ok(capped > 0 && capped <= 40, `limitado a ${String(capped)} s`);
    assert.ok((await main.client.ttl(usedKey)) <= 40);

    // Teto já vencido: a rotação não revive a sessão.
    await main.client.hset(sessKey, 'maxAt', redisNow - 5);
    const sessionHash = (await main.client.hget(sessKey, 'current')) ?? '';
    assert.deepEqual(
      await store.rotate({
        scope: cid,
        sessionId: sid,
        presentedHash: sessionHash,
        newHash: newHash(),
      }),
      { status: 'invalid' },
    );
  });

  it('a sessão criada respeita o menor entre o prazo ocioso e o teto absoluto', async () => {
    const env = await createStore({ idleTtlSeconds: 9_000, maxSeconds: 600 });
    const [cid, sid] = [scope(), randomUUID()];
    await env.store.createSession({
      scope: cid,
      sessionId: sid,
      subjectId: randomUUID(),
      refreshHash: newHash(),
    });
    const ttl = await main.client.ttl(`${env.prefix}${cid}:sess:${sid}`);
    assert.ok(ttl > 0 && ttl <= 600);
  });

  it('o Redis guarda apenas o hash: nenhuma chave nem valor contém o refresh nem o segredo', async () => {
    const env = await createStore();
    const [cid, sid, uid] = [scope(), randomUUID(), randomUUID()];
    const secret1 = randomBytes(48).toString('base64url');
    const secret2 = randomBytes(48).toString('base64url');
    const refresh1 = `${cid}.${sid}.${secret1}`;
    await env.store.createSession({
      scope: cid,
      sessionId: sid,
      subjectId: uid,
      refreshHash: sha(secret1),
    });
    await env.store.rotate({
      scope: cid,
      sessionId: sid,
      presentedHash: sha(secret1),
      newHash: sha(secret2),
    });
    await env.store.rotate({
      scope: cid,
      sessionId: sid,
      presentedHash: sha(secret1),
      newHash: sha(newHash()),
    });
    const dump = await dumpValues(main.client, await env.keys());
    for (const forbidden of [secret1, secret2, refresh1, `${cid}.${sid}.`]) {
      assert.ok(!dump.includes(forbidden), `o Redis contém ${forbidden.slice(0, 16)}...`);
    }
    assert.ok(dump.includes(sha(secret2)), 'o hash do refresh vigente está lá');
  });

  it('toda chave de sessão começa por <prefixo><ClientId|platform>: (login-fail é a exceção declarada)', async () => {
    const env = await createStore();
    const clientId = scope();
    for (const entityScope of [clientId, 'platform']) {
      const [sid, uid] = [randomUUID(), randomUUID()];
      const h1 = newHash();
      await env.store.createSession({
        scope: entityScope,
        sessionId: sid,
        subjectId: uid,
        refreshHash: h1,
      });
      await env.store.rotate({
        scope: entityScope,
        sessionId: sid,
        presentedHash: h1,
        newHash: newHash(),
      });
      await env.store.revokeSession(entityScope, sid);
      await env.store.revokeAllSessions(entityScope, uid);
    }
    await env.store.recordLoginFailure(sha('conta'));
    const keys = await env.keys();
    assert.ok(keys.length > 8);
    const pattern = new RegExp(
      `^${env.prefix}(?:${clientId}|platform):(?:sess|used|usess|rsid|nbf):[0-9a-f-]{36}$`,
    );
    const others = keys.filter((key) => !pattern.test(key));
    assert.deepEqual(others, [`${env.prefix}login-fail:${sha('conta')}`]);
    assert.ok(keys.some((key) => key.startsWith(`${env.prefix}platform:`)));
    assert.ok(keys.some((key) => key.startsWith(`${env.prefix}${clientId}:`)));
  });

  it('escopo, sessão ou hash fora do formato são recusados antes de ir ao Redis', async () => {
    const { store } = await createStore();
    await assert.rejects(
      store.createSession({
        scope: 'a:b',
        sessionId: randomUUID(),
        subjectId: randomUUID(),
        refreshHash: newHash(),
      }),
      RangeError,
    );
    await assert.rejects(
      store.rotate({
        scope: scope(),
        sessionId: 'x',
        presentedHash: newHash(),
        newHash: newHash(),
      }),
      RangeError,
    );
    await assert.rejects(
      store.rotate({
        scope: scope(),
        sessionId: randomUUID(),
        presentedHash: 'curto',
        newHash: newHash(),
      }),
      RangeError,
    );
    await assert.rejects(store.recordLoginFailure('nao-e-hash'), RangeError);
  });
});

describe('RedisSessionStore: bloqueio por conta', () => {
  it('conta falhas, bloqueia no limite com Retry-After <= janela, reseta no sucesso e a chave tem TTL', async () => {
    const env = await createStore({ loginMaxFailures: 3, loginLockSeconds: 600 });
    const { store } = env;
    const key = sha(`c\u0000cliente\u0000${randomUUID()}`);
    assert.deepEqual(await store.loginLockState(key), { locked: false });
    await store.recordLoginFailure(key);
    await store.recordLoginFailure(key);
    assert.deepEqual(await store.loginLockState(key), { locked: false });
    await store.recordLoginFailure(key);
    const locked = await store.loginLockState(key);
    assert.ok(locked.locked);
    assert.ok(locked.retryAfterSeconds >= 1 && locked.retryAfterSeconds <= 600);
    const redisKey = `${env.prefix}login-fail:${key}`;
    const ttl = await main.client.ttl(redisKey);
    assert.ok(ttl > 0 && ttl <= 600);
    await store.resetLoginFailures(key);
    assert.deepEqual(await store.loginLockState(key), { locked: false });
    assert.equal(await main.client.exists(redisKey), 0);
  });

  it('o contador expira: passada a janela, a conta volta a poder tentar', async () => {
    const env = await createStore({ loginMaxFailures: 2, loginLockSeconds: 600 });
    const key = sha(randomUUID());
    await env.store.recordLoginFailure(key);
    await env.store.recordLoginFailure(key);
    assert.ok((await env.store.loginLockState(key)).locked);
    // Encurta a janela da própria chave do teste e espera com prazo (sondagem, sem sleep fixo).
    await main.client.pexpire(`${env.prefix}login-fail:${key}`, 150);
    const deadline = Date.now() + 5_000;
    let unlocked = false;
    while (Date.now() < deadline && !unlocked) {
      unlocked = !(await env.store.loginLockState(key)).locked;
      if (!unlocked) await sleep(50);
    }
    assert.ok(unlocked, 'o bloqueio não expirou');
  });

  it('contas diferentes têm contadores independentes', async () => {
    const env = await createStore({ loginMaxFailures: 1 });
    const [one, two] = [sha(randomUUID()), sha(randomUUID())];
    await env.store.recordLoginFailure(one);
    assert.ok((await env.store.loginLockState(one)).locked);
    assert.equal((await env.store.loginLockState(two)).locked, false);
  });
});

describe('RedisSessionStore: Redis fora (fail-closed)', () => {
  it(
    'toda operação lança ServiceUnavailableError, nunca aceita nem emite nada, e volta quando o Redis volta',
    { timeout: 60_000 },
    async () => {
      const url = new URL(config.REDIS_URL);
      const proxy = new ToggleProxy(url.hostname, Number(url.port || '6379'));
      await proxy.start();
      const viaProxy = new URL(config.REDIS_URL);
      viaProxy.hostname = '127.0.0.1';
      viaProxy.port = String(proxy.listeningPort);
      const env = await createStore({}, viaProxy.toString());
      try {
        const [cid, sid, uid] = [scope(), randomUUID(), randomUUID()];
        const h1 = newHash();
        await env.store.createSession({
          scope: cid,
          sessionId: sid,
          subjectId: uid,
          refreshHash: h1,
        });

        const operations: readonly (() => Promise<unknown>)[] = [
          () =>
            env.store.createSession({
              scope: cid,
              sessionId: randomUUID(),
              subjectId: uid,
              refreshHash: newHash(),
            }),
          () =>
            env.store.rotate({ scope: cid, sessionId: sid, presentedHash: h1, newHash: newHash() }),
          () => env.store.revokeByRefresh({ scope: cid, sessionId: sid, presentedHash: h1 }),
          () => env.store.revokeSession(cid, sid),
          () => env.store.revokeAllSessions(cid, uid),
          () => env.store.checkAccess({ scope: cid, sessionId: sid, subjectId: uid, issuedAt: 1 }),
          () => env.store.loginLockState(sha('x')),
          () => env.store.recordLoginFailure(sha('x')),
          () => env.store.resetLoginFailures(sha('x')),
        ];

        // 1. Lento (blackhole): estoura o prazo do comando.
        proxy.mode = 'blackhole';
        for (const operation of operations) {
          await assert.rejects(operation, ServiceUnavailableError);
        }
        // 2. Fora (porta recusa): idem, sem esperar.
        proxy.mode = 'forward';
        await proxy.stop();
        for (const operation of operations) {
          await assert.rejects(operation, ServiceUnavailableError);
        }
        // 3. De volta: a mesma sessão segue intacta (nada foi aceito nem alterado durante a queda).
        await proxy.start();
        const deadline = Date.now() + 15_000;
        let result: unknown;
        while (Date.now() < deadline) {
          try {
            result = await env.store.rotate({
              scope: cid,
              sessionId: sid,
              presentedHash: h1,
              newHash: newHash(),
            });
            break;
          } catch {
            await sleep(100);
          }
        }
        assert.deepEqual(result, { status: 'rotated', subjectId: uid });
      } finally {
        await proxy.stop();
      }
    },
  );
});
