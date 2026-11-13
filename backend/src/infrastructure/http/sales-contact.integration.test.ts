import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { AccountService } from '../../application/auth/account.service.js';
import { deriveSalesContactKey, issueFormToken } from '../../application/contact/form-token.js';
import { SalesContactService } from '../../application/contact/sales-contact.service.js';
import type {
  SalesContactMail,
  SalesContactMailer,
} from '../../application/ports/sales-contact.js';
import { Result } from '../../shared/types/index.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { captureLogs, type LogCapture } from '../../test-support/log-capture.js';
import { TestKeyspace } from '../../test-support/test-keyspace.js';
import { ToggleProxy } from '../../test-support/toggle-proxy.js';
import { createAuthRedis } from '../auth/auth-redis.js';
import { RedisSalesContactCap } from '../auth/redis-sales-contact-cap.js';
import { createRateLimitRedis } from '../cache/rate-limit-redis.js';
import { createRedis, type RedisHandle } from '../cache/redis.client.js';
import { createMetrics } from '../metrics/index.js';
import type { RateLimitProfiles } from './rate-limit/rate-limit.js';
import { buildServer } from './server.js';

// Spec 040 (E4): perfil `contact` com o Redis real (/15) e o teto diário real; e-mail falso. Prefixo único por
// teste, sem FLUSHALL/FLUSHDB.
const config = loadIntegrationConfig();
const ORIGIN = 'http://localhost:5174';
const KEY = deriveSalesContactKey(randomUUID());
const METRICS_TOKEN = `it-${randomUUID()}-${randomUUID()}`;

const S = {
  name: 'Sentinela Nome Rl',
  email: 'sentinela.rl@empresa.test',
  phone: '+55 11 96666-4321',
  companyName: 'Sentinela Empresa Rl',
  message: 'Sentinela mensagem Rl, texto suficiente.',
  website: 'sentinela-honeypot-rl',
} as const;

const PROFILES: RateLimitProfiles = {
  public: { max: 1_000, windowSeconds: 60 },
  admin: { max: 1_000, windowSeconds: 60 },
  webhook: { max: 1_000, windowSeconds: 60 },
  login: { max: 1_000, windowSeconds: 60 },
  refresh: { max: 1_000, windowSeconds: 60 },
  contact: { max: 5, windowSeconds: 3_600 },
};

class FakeMailer implements SalesContactMailer {
  readonly sent: SalesContactMail[] = [];
  sendSalesContact(_to: string, mail: SalesContactMail): Promise<void> {
    this.sent.push(mail);
    return Promise.resolve();
  }
}

let main: RedisHandle;
before(() => {
  main = createRedis(config, captureLogs().logger);
});
after(async () => {
  await main.close();
});

interface Harness {
  readonly app: FastifyInstance;
  readonly logs: LogCapture;
  readonly mailer: FakeMailer;
  readonly service: SalesContactService;
  post(ip?: string): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

async function harness(limiterUrl: string = config.REDIS_URL): Promise<Harness> {
  const logs = captureLogs();
  const keyspace = new TestKeyspace();
  const limiter = createRateLimitRedis(
    { REDIS_URL: limiterUrl, RATE_LIMIT_REDIS_TIMEOUT_MS: 250 },
    logs.logger,
  );
  assert.ok(await limiter.waitUntilReady(5_000));
  const authRedis = createAuthRedis(
    { REDIS_URL: config.REDIS_URL, AUTH_REDIS_TIMEOUT_MS: 500 },
    logs.logger,
  );
  assert.ok(await authRedis.waitUntilReady(5_000));
  const mailer = new FakeMailer();
  const metrics = createMetrics();
  const service = new SalesContactService({
    mailer,
    cap: new RedisSalesContactCap(authRedis.client, keyspace.scopedPrefix('sales-cap')),
    formKey: KEY,
    recipient: 'vendas@soprei.test',
    logger: logs.logger,
    metrics,
  });
  const app = buildServer({
    logger: logs.logger,
    readiness: {
      database: () => Promise.resolve(Result.ok(undefined)),
      redis: () => Promise.resolve(Result.ok(undefined)),
    },
    metrics,
    metricsToken: METRICS_TOKEN,
    accounts: {
      service: { drain: () => Promise.resolve() } as unknown as AccountService,
      origin: ORIGIN,
      secure: false,
      salesContact: service,
    },
    rateLimit: {
      redis: limiter.client,
      profiles: PROFILES,
      keyPrefix: keyspace.scopedPrefix('rl-contact'),
    },
  });
  await app.ready();
  return {
    app,
    logs,
    mailer,
    service,
    post: (ip = '198.51.100.7') =>
      app.inject({
        method: 'POST',
        url: '/contact/sales',
        remoteAddress: ip,
        headers: { origin: ORIGIN, 'x-soprei-app': 'web' },
        payload: {
          name: S.name,
          email: S.email,
          phone: S.phone,
          companyName: S.companyName,
          units: '11-30',
          monthlyVolume: 'nao-sei',
          message: S.message,
          privacyAck: true,
          website: '',
          formToken: issueFormToken(KEY, Date.now() - 10_000),
        },
      }),
    async close() {
      try {
        await service.drain();
        await app.close();
        await limiter.close();
        await authRedis.close();
      } finally {
        await keyspace.cleanup(main.client);
      }
    },
  };
}

async function assertPrivate(h: Harness): Promise<void> {
  const metricsText = (
    await h.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    })
  ).body;
  for (const value of Object.values(S)) {
    assert.ok(!h.logs.raw().includes(value), `log contém ${value}`);
    assert.ok(!metricsText.includes(value), `/metrics contém ${value}`);
  }
}

describe('perfil contact com Redis real (spec 040, D13)', () => {
  it(
    'o 6º POST do mesmo IP em 1 h recebe 429 com Retry-After; outro IP segue livre',
    { timeout: 30_000 },
    async () => {
      const h = await harness();
      try {
        const statuses: number[] = [];
        for (let i = 0; i < 6; i += 1) statuses.push((await h.post()).statusCode);
        assert.deepEqual(statuses, [202, 202, 202, 202, 202, 429]);
        const limited = await h.post();
        assert.equal(limited.statusCode, 429);
        const retryAfter = Number(limited.headers['retry-after']);
        assert.ok(retryAfter > 3_000 && retryAfter <= 3_600, `Retry-After ${String(retryAfter)}`);
        assert.equal((await h.post('198.51.100.8')).statusCode, 202);
        await h.service.drain();
        assert.equal(h.mailer.sent.length, 6);
        await assertPrivate(h);
      } finally {
        await h.close();
      }
    },
  );

  it('Redis do limiter fora: 503 e nada enviado; de volta, 202', { timeout: 60_000 }, async () => {
    const redisUrl = new URL(config.REDIS_URL);
    const proxy = new ToggleProxy(redisUrl.hostname, Number(redisUrl.port || '6379'));
    await proxy.start();
    const viaProxy = new URL(config.REDIS_URL);
    viaProxy.hostname = '127.0.0.1';
    viaProxy.port = String(proxy.listeningPort);
    const h = await harness(viaProxy.toString());
    try {
      await proxy.stop();
      const down = await h.post();
      assert.equal(down.statusCode, 503);
      assert.equal(down.json<{ error: { code: string } }>().error.code, 'SERVICE_UNAVAILABLE');
      await h.service.drain();
      assert.equal(h.mailer.sent.length, 0);

      proxy.mode = 'forward';
      await proxy.start();
      // Sondagem com prazo: o ioredis do limiter reconecta sozinho.
      let status = 0;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        status = (await h.post()).statusCode;
        if (status === 202) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert.equal(status, 202);
      await h.service.drain();
      assert.equal(h.mailer.sent.length, 1);
      await assertPrivate(h);
    } finally {
      await h.close();
      await proxy.stop();
    }
  });
});
