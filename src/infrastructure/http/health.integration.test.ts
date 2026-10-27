import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRedis } from '../cache/redis.client.js';
import { createDatabase } from '../database/index.js';
import { buildServer } from './server.js';
import { createLogger } from '../logger/logger.js';
import { getClosedPort, withPort } from '../../test-support/closed-port.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';

// Falha aqui (antes de abrir qualquer conexão) se o ambiente não for o de testes.
const config = loadIntegrationConfig();
const logger = createLogger(config);

async function getReady(
  databaseUrl: string,
  redisUrl: string,
  beforeRequest?: (handles: { redis: ReturnType<typeof createRedis> }) => Promise<void>,
): Promise<{ statusCode: number; body: unknown; raw: string }> {
  const database = createDatabase(
    { ...config, DATABASE_URL: databaseUrl, DB_POOL_CONNECTION_TIMEOUT_MS: 1_000 },
    logger,
  );
  const redis = createRedis({ REDIS_URL: redisUrl }, logger);
  const app = buildServer({
    logger,
    readiness: { database: () => database.check(1_500), redis: () => redis.check(1_500) },
  });
  try {
    await beforeRequest?.({ redis });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    return { statusCode: response.statusCode, body: response.json(), raw: response.body };
  } finally {
    await app.close();
    await database.close();
    await redis.close();
  }
}

describe('GET /health/ready com infraestrutura real', () => {
  it('responde 200 com banco e Redis no ar', async () => {
    const { statusCode, body } = await getReady(config.DATABASE_URL, config.REDIS_URL);
    assert.equal(statusCode, 200);
    assert.deepEqual(body, { status: 'ok', checks: { database: 'up', redis: 'up' } });
  });

  it('responde 503 quando o banco está indisponível (porta fechada)', async () => {
    const closed = withPort(config.DATABASE_URL, await getClosedPort());
    const { statusCode, body, raw } = await getReady(closed, config.REDIS_URL);
    assert.equal(statusCode, 503);
    assert.deepEqual(body, { status: 'unavailable', checks: { database: 'down', redis: 'up' } });
    assert.ok(!/ECONNREFUSED|127\.0\.0\.1|localhost/.test(raw));
  });

  it('responde 503 quando o Redis está indisponível (porta fechada)', async () => {
    const closed = withPort(config.REDIS_URL, await getClosedPort());
    const { statusCode, body } = await getReady(config.DATABASE_URL, closed);
    assert.equal(statusCode, 503);
    assert.deepEqual(body, { status: 'unavailable', checks: { database: 'up', redis: 'down' } });
  });

  it('responde 503 quando o Redis cai com o servidor no ar (client desconectado)', async () => {
    const { statusCode, body } = await getReady(
      config.DATABASE_URL,
      config.REDIS_URL,
      async ({ redis }) => {
        assert.ok((await redis.check()).ok);
        redis.client.disconnect();
      },
    );
    assert.equal(statusCode, 503);
    assert.deepEqual(body, { status: 'unavailable', checks: { database: 'up', redis: 'down' } });
  });

  it('responde 503 com os dois indisponíveis', async () => {
    const { statusCode, body } = await getReady(
      withPort(config.DATABASE_URL, await getClosedPort()),
      withPort(config.REDIS_URL, await getClosedPort()),
    );
    assert.equal(statusCode, 503);
    assert.deepEqual(body, { status: 'unavailable', checks: { database: 'down', redis: 'down' } });
  });
});
