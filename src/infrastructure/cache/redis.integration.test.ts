import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ExternalServiceError } from '../../shared/errors/index.js';
import { getClosedPort, withPort } from '../../test-support/closed-port.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { TestKeyspace } from '../../test-support/test-keyspace.js';
import { createLogger } from '../logger/logger.js';
import { createRedis, type RedisHandle } from './redis.client.js';

// Falha aqui (antes de abrir qualquer conexão) se o ambiente não for o de testes.
const config = loadIntegrationConfig();
const logger = createLogger(config);

let redis: RedisHandle;
const keyspace = new TestKeyspace();

before(() => {
  redis = createRedis(config, logger);
});

after(async () => {
  try {
    // Remove só as chaves criadas por este arquivo.
    await keyspace.cleanup(redis.client);
  } finally {
    await redis.close();
  }
});

describe('client Redis de testes', () => {
  it('check() responde ok com o Redis no ar', async () => {
    const result = await redis.check();
    assert.ok(result.ok);
  });

  it('está no índice 15', () => {
    assert.equal(redis.client.options.db, 15);
  });

  it('grava e lê uma chave com prefixo único, e a remove', async () => {
    const key = keyspace.key('ping');
    await redis.client.set(key, 'pong', 'EX', 60);
    assert.equal(await redis.client.get(key), 'pong');
    await keyspace.cleanup(redis.client);
    assert.equal(await redis.client.get(key), null);
  });

  it('check() devolve ExternalServiceError (sem lançar) quando o Redis está inacessível', async () => {
    const unreachable = createRedis(
      { REDIS_URL: withPort(config.REDIS_URL, await getClosedPort()) },
      logger,
    );
    try {
      const result = await unreachable.check(1_500);
      assert.equal(result.ok, false);
      assert.ok(result.error instanceof ExternalServiceError);
    } finally {
      await unreachable.close();
    }
  });

  it('check() falha depois que o client é desconectado (e close() é idempotente)', async () => {
    const own = createRedis(config, logger);
    assert.ok((await own.check()).ok);
    await own.close();
    await own.close();
    assert.equal(own.client.status, 'end');
    const result = await own.check(1_000);
    assert.equal(result.ok, false);
  });
});
