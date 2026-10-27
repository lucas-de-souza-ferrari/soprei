import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildTestServer } from '../../infrastructure/http/test-server.js';
import { DatabaseError, ExternalServiceError } from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import type { ReadinessChecks } from './health.controller.js';

const up = (): ReturnType<ReadinessChecks['database']> => Promise.resolve(Result.ok(undefined));

describe('GET /health', () => {
  it('responde 200 com { status: "ok" }', async () => {
    const app = buildTestServer();
    try {
      const response = await app.inject({ method: 'GET', url: '/health' });
      assert.equal(response.statusCode, 200);
      assert.match(String(response.headers['content-type']), /application\/json/);
      assert.deepEqual(response.json(), { status: 'ok' });
    } finally {
      await app.close();
    }
  });

  it('continua 200 mesmo com banco e Redis fora (só indica que o processo está vivo)', async () => {
    const app = buildTestServer({
      database: () => Promise.resolve(Result.err(new DatabaseError())),
      redis: () => Promise.resolve(Result.err(new ExternalServiceError())),
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/health' });
      assert.equal(response.statusCode, 200);
    } finally {
      await app.close();
    }
  });
});

describe('GET /health/ready', () => {
  it('responde 200 quando banco e Redis respondem', async () => {
    const app = buildTestServer({ database: up, redis: up });
    try {
      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), {
        status: 'ok',
        checks: { database: 'up', redis: 'up' },
      });
    } finally {
      await app.close();
    }
  });

  it('responde 503 indicando o banco, sem detalhes internos', async () => {
    const secret = 'senha-no-erro-interno';
    const app = buildTestServer({
      database: () =>
        Promise.resolve(Result.err(new DatabaseError('falhou', { cause: new Error(secret) }))),
      redis: up,
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), {
        status: 'unavailable',
        checks: { database: 'down', redis: 'up' },
      });
      assert.ok(!response.body.includes(secret));
    } finally {
      await app.close();
    }
  });

  it('responde 503 indicando o Redis', async () => {
    const app = buildTestServer({
      database: up,
      redis: () => Promise.resolve(Result.err(new ExternalServiceError())),
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), {
        status: 'unavailable',
        checks: { database: 'up', redis: 'down' },
      });
    } finally {
      await app.close();
    }
  });
});
