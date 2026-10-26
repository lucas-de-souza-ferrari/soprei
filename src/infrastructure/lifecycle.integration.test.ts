import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getClosedPort, withPort } from '../test-support/closed-port.js';
import { loadIntegrationConfig } from '../test-support/integration-env.js';
import { createRedis } from './cache/redis.client.js';
import { createDatabase } from './database/database.js';
import { closeInfrastructure, verifyInfrastructure } from './lifecycle.js';
import { createLogger } from './logger/logger.js';

// Falha aqui (antes de abrir qualquer conexão) se o ambiente não for o de testes.
const config = loadIntegrationConfig();
const logger = createLogger(config);

const PROBE = fileURLToPath(new URL('../test-support/shutdown-probe.ts', import.meta.url));
const TSX = import.meta.resolve('tsx');

describe('verifyInfrastructure', () => {
  it('não aponta nada quando banco e Redis estão no ar', async () => {
    const database = createDatabase(config, logger);
    const redis = createRedis(config, logger);
    try {
      assert.deepEqual(await verifyInfrastructure({ database, redis }, logger), []);
    } finally {
      await closeInfrastructure({ database, redis }, logger);
    }
  });

  it('aponta só o Redis quando ele está indisponível', async () => {
    const database = createDatabase(config, logger);
    const redis = createRedis(
      { REDIS_URL: withPort(config.REDIS_URL, await getClosedPort()) },
      logger,
    );
    try {
      assert.deepEqual(await verifyInfrastructure({ database, redis }, logger), ['Redis']);
    } finally {
      await closeInfrastructure({ database, redis }, logger);
    }
  });

  it('aponta só o PostgreSQL quando ele está indisponível', async () => {
    const database = createDatabase(
      {
        ...config,
        DATABASE_URL: withPort(config.DATABASE_URL, await getClosedPort()),
        DB_POOL_CONNECTION_TIMEOUT_MS: 1_000,
      },
      logger,
    );
    const redis = createRedis(config, logger);
    try {
      assert.deepEqual(await verifyInfrastructure({ database, redis }, logger), ['PostgreSQL']);
    } finally {
      await closeInfrastructure({ database, redis }, logger);
    }
  });
});

describe('shutdown', () => {
  it('fecha pool e Redis: o processo termina sozinho, sem handle aberto', () => {
    const result = spawnSync(process.execPath, ['--import', TSX, PROBE], {
      env: process.env,
      encoding: 'utf8',
      timeout: 60_000,
    });

    assert.equal(result.error, undefined, 'o probe não terminou sozinho (handle aberto?)');
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout.trim()) as {
      poolTotalBefore: number;
      poolTotalAfter: number;
      redisStatus: string;
    };
    assert.ok(report.poolTotalBefore >= 1, 'o pool deveria ter aberto conexão antes do close');
    assert.equal(report.poolTotalAfter, 0);
    assert.equal(report.redisStatus, 'end');
  });

  it('closeInfrastructure é idempotente', async () => {
    const database = createDatabase(config, logger);
    const redis = createRedis(config, logger);
    assert.ok((await database.check()).ok);
    assert.ok((await redis.check()).ok);
    await closeInfrastructure({ database, redis }, logger);
    await closeInfrastructure({ database, redis }, logger);
    assert.equal(redis.client.status, 'end');
  });
});
