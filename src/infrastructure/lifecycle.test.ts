import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it } from 'node:test';
import { captureLogs } from '../test-support/log-capture.js';
import type { Database } from './database/index.js';
import type { RateLimitRedisHandle } from './cache/rate-limit-redis.js';
import type { RedisHandle } from './cache/redis.client.js';
import { closeInfrastructure, type Infrastructure } from './lifecycle.js';

function build(events: string[], queueClose: () => Promise<void>): Infrastructure {
  return {
    database: {
      close: async () => {
        events.push('database:start');
        await sleep(5);
        events.push('database:end');
      },
    } as unknown as Database,
    redis: {
      close: async () => {
        events.push('redis:start');
        await sleep(5);
        events.push('redis:end');
      },
    } as unknown as RedisHandle,
    rateLimitRedis: {
      close: () => {
        events.push('rateLimitRedis:start');
        return Promise.resolve();
      },
    } as unknown as RateLimitRedisHandle,
    inboundQueue: {
      close: async () => {
        events.push('queue:start');
        await queueClose();
        events.push('queue:end');
      },
    },
  };
}

describe('closeInfrastructure (spec 011)', () => {
  it('a fila e o worker terminam de fechar ANTES de o banco e o Redis começarem a fechar', async () => {
    const events: string[] = [];
    const infrastructure = build(events, () => sleep(60));

    await closeInfrastructure(infrastructure, captureLogs().logger);

    const queueEnd = events.indexOf('queue:end');
    assert.ok(queueEnd >= 0);
    for (const later of ['database:start', 'redis:start', 'rateLimitRedis:start']) {
      assert.ok(
        events.indexOf(later) > queueEnd,
        `${later} depois de queue:end: ${events.join(',')}`,
      );
    }
    assert.ok(events.includes('database:end') && events.includes('redis:end'));
  });

  it('se a fila falha ao fechar, loga e ainda fecha banco e Redis', async () => {
    const events: string[] = [];
    const logs = captureLogs();
    const infrastructure = build(events, () =>
      Promise.reject(new Error('fila quebrada com segredo-1')),
    );

    await closeInfrastructure(infrastructure, logs.logger);

    assert.ok(events.includes('database:end'));
    assert.ok(events.includes('redis:end'));
    const line = logs.lines().find((entry) => entry.msg === 'falha ao encerrar a fila de entrada');
    assert.equal(line?.level, 50);
    assert.ok(!logs.raw().includes('segredo-1'));
  });

  it('sem fila (canal desligado) o fechamento é o de antes', async () => {
    const events: string[] = [];
    const infrastructure = { ...build(events, () => Promise.resolve()), inboundQueue: undefined };
    await closeInfrastructure(infrastructure, captureLogs().logger);
    assert.deepEqual(
      events.filter((event) => event.startsWith('queue')),
      [],
    );
    assert.ok(events.includes('database:end'));
  });
});
