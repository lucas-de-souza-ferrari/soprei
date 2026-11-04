import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { CompanyService } from '../../../application/companies/company.service.js';
import { rateLimitProfile } from '../../../presentation/common/rate-limit.js';
import { Result } from '../../../shared/types/index.js';
import { getClosedPort, withPort } from '../../../test-support/closed-port.js';
import { loadIntegrationConfig } from '../../../test-support/integration-env.js';
import { buildTestAuth } from '../../../test-support/in-memory-auth.js';
import { InMemoryCompanyRepository } from '../../../test-support/in-memory-company.repository.js';
import { captureLogs, type LogCapture } from '../../../test-support/log-capture.js';
import { TestKeyspace } from '../../../test-support/test-keyspace.js';
import { ToggleProxy } from '../../../test-support/toggle-proxy.js';
import { createRateLimitRedis, type RateLimitRedisHandle } from '../../cache/rate-limit-redis.js';
import { createRedis, type RedisHandle } from '../../cache/redis.client.js';
import type { TrustProxySetting } from '../../config/trust-proxy.js';
import { createMetrics, type Metrics } from '../../metrics/index.js';
import { type RateLimitProfiles } from './rate-limit.js';
import { buildServer } from '../server.js';

// Falha aqui (antes de abrir qualquer conexão) se o ambiente não for o de testes. Todo teste
// usa o Redis /15 e um namespace único (TestKeyspace), e remove só as próprias chaves.
const config = loadIntegrationConfig();
const METRICS_TOKEN = `it-${randomUUID()}-${randomUUID()}`;
const REDIS_TIMEOUT_MS = 250;

const ALL_UP = {
  database: () => Promise.resolve(Result.ok(undefined)),
  redis: () => Promise.resolve(Result.ok(undefined)),
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function profiles(overrides: Partial<RateLimitProfiles> = {}): RateLimitProfiles {
  return {
    public: { max: 1_000, windowSeconds: 60 },
    admin: { max: 1_000, windowSeconds: 60 },
    webhook: { max: 1_000, windowSeconds: 60 },
    login: { max: 1_000, windowSeconds: 60 },
    refresh: { max: 1_000, windowSeconds: 60 },
    ...overrides,
  };
}

interface Harness {
  readonly app: FastifyInstance;
  readonly logs: LogCapture;
  readonly metrics: Metrics;
  readonly handle: RateLimitRedisHandle;
  readonly keyspace: TestKeyspace;
  readonly prefix: string;
  /** Access token de um `PlatformAdmin` (acesso a `/admin/companies`). */
  readonly adminToken: string;
  /** Chaves do contador que existem agora neste teste (só as dele). */
  keys(): Promise<string[]>;
  get(url: string, options?: GetOptions): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

interface GetOptions {
  readonly ip?: string;
  readonly headers?: Record<string, string>;
}

interface HarnessOptions {
  readonly profiles?: RateLimitProfiles;
  readonly trustProxy?: TrustProxySetting;
  readonly redisUrl?: string;
  readonly waitReady?: boolean;
}

let mainRedis: RedisHandle;

before(() => {
  mainRedis = createRedis(config, captureLogs().logger);
});

after(async () => {
  await mainRedis.close();
});

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const logs = captureLogs();
  const metrics = createMetrics();
  const keyspace = new TestKeyspace();
  const prefix = keyspace.scopedPrefix('rl');
  const handle = createRateLimitRedis(
    {
      REDIS_URL: options.redisUrl ?? config.REDIS_URL,
      RATE_LIMIT_REDIS_TIMEOUT_MS: REDIS_TIMEOUT_MS,
    },
    logs.logger,
  );
  if (options.waitReady ?? true) {
    assert.ok(await handle.waitUntilReady(5_000), 'conexão do rate limit não ficou pronta');
  }

  const testAuth = buildTestAuth({ logger: logs.logger });
  const adminToken = (await testAuth.platformToken()).accessToken;
  const app = buildServer({
    logger: logs.logger,
    readiness: ALL_UP,
    metrics,
    metricsToken: METRICS_TOKEN,
    auth: testAuth.service,
    admin: { companies: new CompanyService(new InMemoryCompanyRepository()) },
    ...(options.trustProxy === undefined ? {} : { trustProxy: options.trustProxy }),
    rateLimit: {
      redis: handle.client,
      profiles: options.profiles ?? profiles(),
      keyPrefix: prefix,
    },
  });
  // Rotas só dos testes. Dentro de um plugin: o hook do rate limit só vale para rotas
  // registradas depois dele na fila de plugins (as do servidor real vêm de `register`).
  void app.register((instance, _options, done) => {
    instance.get('/test/sem-perfil', () => ({ ok: true }));
    instance.get('/test/webhook', { config: rateLimitProfile('webhook') }, () => ({ ok: true }));
    instance.get('/test/ip', (request) => ({ ip: request.ip }));
    done();
  });
  await app.ready();

  return {
    app,
    logs,
    metrics,
    handle,
    keyspace,
    prefix,
    adminToken,
    keys: () => keyspace.keysUnder(mainRedis.client, prefix),
    get: (url, { ip = '203.0.113.1', headers = {} } = {}) =>
      app.inject({ method: 'GET', url, remoteAddress: ip, headers }),
    async close() {
      try {
        await app.close();
        await handle.close();
      } finally {
        await keyspace.cleanup(mainRedis.client);
      }
    },
  };
}

/** Roda o teste com um harness e fecha tudo no fim, passe ou falhe. */
async function withHarness(
  options: HarnessOptions,
  body: (harness: Harness) => Promise<void>,
): Promise<void> {
  const harness = await createHarness(options);
  try {
    await body(harness);
  } finally {
    await harness.close();
  }
}

const statuses = (responses: readonly LightMyRequestResponse[]): number[] =>
  responses.map((response) => response.statusCode);

async function repeat(
  harness: Harness,
  times: number,
  url: string,
  options?: GetOptions,
): Promise<LightMyRequestResponse[]> {
  const responses: LightMyRequestResponse[] = [];
  for (let i = 0; i < times; i += 1) responses.push(await harness.get(url, options));
  return responses;
}

interface RateLimitedBody {
  error: { code: string; message: string; requestId: string; retryAfter: number };
}

describe('resposta 429', () => {
  it('a requisição seguinte ao limite recebe 429 no formato padrão e com os cabeçalhos', async () => {
    await withHarness(
      { profiles: profiles({ public: { max: 2, windowSeconds: 30 } }) },
      async (h) => {
        const [first, second, third] = await repeat(h, 3, '/test/sem-perfil');
        assert.ok(first && second && third);
        assert.equal(first.statusCode, 200);
        assert.equal(first.headers['x-ratelimit-limit'], '2');
        assert.equal(first.headers['x-ratelimit-remaining'], '1');
        assert.equal(second.statusCode, 200);
        assert.equal(second.headers['x-ratelimit-remaining'], '0');

        assert.equal(third.statusCode, 429);
        const body = third.json<RateLimitedBody>();
        assert.deepEqual(Object.keys(body), ['error']);
        assert.deepEqual(Object.keys(body.error).sort(), [
          'code',
          'message',
          'requestId',
          'retryAfter',
        ]);
        assert.equal(body.error.code, 'RATE_LIMITED');
        assert.equal(body.error.message, 'Muitas requisições. Tente novamente em instantes.');
        assert.equal(body.error.requestId, third.headers['x-request-id']);

        assert.ok(Number.isInteger(body.error.retryAfter));
        assert.ok(body.error.retryAfter >= 1 && body.error.retryAfter <= 30);
        assert.equal(third.headers['retry-after'], String(body.error.retryAfter));
        assert.equal(third.headers['x-ratelimit-limit'], '2');
        assert.equal(third.headers['x-ratelimit-remaining'], '0');
        const reset = Number(third.headers['x-ratelimit-reset']);
        assert.ok(Number.isInteger(reset) && reset >= 1 && reset <= 30);
        // Sem a variante `draft` dos cabeçalhos.
        assert.equal(third.headers['ratelimit-limit'], undefined);
      },
    );
  });

  it('o resto das respostas de erro não muda de formato (404 de rota inexistente)', async () => {
    await withHarness({}, async (h) => {
      const response = await h.get('/nao-existe');
      assert.equal(response.statusCode, 404);
      const body = response.json<{ error: Record<string, unknown> }>();
      assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message', 'requestId']);
    });
  });
});

describe('perfis e cotas', () => {
  it('cada perfil aplica o seu limite; rota sem perfil usa public', async () => {
    await withHarness(
      {
        profiles: profiles({
          public: { max: 3, windowSeconds: 60 },
          admin: { max: 2, windowSeconds: 60 },
          webhook: { max: 4, windowSeconds: 60 },
        }),
      },
      async (h) => {
        const auth = { authorization: `Bearer ${h.adminToken}` };
        assert.deepEqual(
          statuses(await repeat(h, 5, '/test/sem-perfil')),
          [200, 200, 200, 429, 429],
          'public',
        );
        assert.deepEqual(
          statuses(await repeat(h, 4, '/admin/companies', { headers: auth })),
          [200, 200, 429, 429],
          'admin',
        );
        assert.deepEqual(
          statuses(await repeat(h, 6, '/test/webhook')),
          [200, 200, 200, 200, 429, 429],
          'webhook',
        );
      },
    );
  });

  it('perfis independentes: esgotar admin não limita webhook nem public do mesmo IP', async () => {
    await withHarness(
      {
        profiles: profiles({
          admin: { max: 1, windowSeconds: 60 },
          webhook: { max: 1, windowSeconds: 60 },
          public: { max: 1, windowSeconds: 60 },
        }),
      },
      async (h) => {
        assert.deepEqual(statuses(await repeat(h, 3, '/admin/companies')), [401, 429, 429]);
        assert.equal((await h.get('/test/webhook')).statusCode, 200);
        assert.equal((await h.get('/test/webhook')).statusCode, 429);
        assert.equal((await h.get('/test/sem-perfil')).statusCode, 200);
        // E as três chaves existem, uma por perfil, todas do mesmo IP.
        const keys = (await h.keys()).map((key) => key.slice(h.prefix.length)).sort();
        assert.deepEqual(keys, ['admin:203.0.113.1', 'public:203.0.113.1', 'webhook:203.0.113.1']);
      },
    );
  });

  it('IPs diferentes têm cotas independentes (webhook esgotado de um IP não limita outro)', async () => {
    await withHarness(
      { profiles: profiles({ webhook: { max: 2, windowSeconds: 60 } }) },
      async (h) => {
        const attacker = { ip: '198.51.100.66' };
        const meta = { ip: '203.0.113.200' };
        assert.deepEqual(
          statuses(await repeat(h, 5, '/test/webhook', attacker)),
          [200, 200, 429, 429, 429],
        );
        assert.deepEqual(statuses(await repeat(h, 2, '/test/webhook', meta)), [200, 200]);
        assert.equal((await h.get('/test/webhook', meta)).statusCode, 429);
      },
    );
  });

  it('/health, /health/ready, /metrics e rota inexistente respondem normalmente acima do limite', async () => {
    await withHarness(
      { profiles: profiles({ public: { max: 1, windowSeconds: 60 } }) },
      async (h) => {
        const metricsAuth = { authorization: `Bearer ${METRICS_TOKEN}` };
        assert.deepEqual(statuses(await repeat(h, 6, '/health')), [200, 200, 200, 200, 200, 200]);
        assert.deepEqual(
          statuses(await repeat(h, 6, '/health/ready')),
          [200, 200, 200, 200, 200, 200],
        );
        assert.deepEqual(
          statuses(await repeat(h, 6, '/metrics', { headers: metricsAuth })),
          [200, 200, 200, 200, 200, 200],
        );
        assert.deepEqual(
          statuses(await repeat(h, 6, '/nao-existe')),
          [404, 404, 404, 404, 404, 404],
        );
        // Nada disso criou chave: e a cota public do IP continua intacta.
        assert.deepEqual(await h.keys(), []);
        assert.equal((await h.get('/test/sem-perfil')).statusCode, 200);
      },
    );
  });

  it('/admin/* é limitado antes da autenticação: sem credencial conta e, esgotado, vem 429 e não 401', async () => {
    await withHarness(
      { profiles: profiles({ admin: { max: 3, windowSeconds: 60 } }) },
      async (h) => {
        assert.deepEqual(
          statuses(await repeat(h, 5, '/admin/companies')),
          [401, 401, 401, 429, 429],
        );
        // Credencial certa, mas depois do limite: também 429 (a chave nem é conferida).
        const withKey = await h.get('/admin/companies', {
          headers: { authorization: `Bearer ${h.adminToken}` },
        });
        assert.equal(withKey.statusCode, 429);
      },
    );
  });
});

describe('normalização do IP na chave', () => {
  it('IPv4 mapeado em IPv6 e o IPv4 compartilham chave; a chave é <perfil>:<ip normalizado>', async () => {
    await withHarness(
      { profiles: profiles({ public: { max: 1, windowSeconds: 60 } }) },
      async (h) => {
        assert.equal((await h.get('/test/sem-perfil', { ip: '203.0.113.7' })).statusCode, 200);
        assert.equal(
          (await h.get('/test/sem-perfil', { ip: '::ffff:203.0.113.7' })).statusCode,
          429,
        );
        assert.deepEqual(
          (await h.keys()).map((key) => key.slice(h.prefix.length)),
          ['public:203.0.113.7'],
        );
      },
    );
  });

  it('IPv6 do mesmo /64 compartilha chave; de /64 diferente, não', async () => {
    await withHarness(
      { profiles: profiles({ public: { max: 1, windowSeconds: 60 } }) },
      async (h) => {
        assert.equal(
          (await h.get('/test/sem-perfil', { ip: '2001:db8:aaaa:bbbb::1' })).statusCode,
          200,
        );
        assert.equal(
          (await h.get('/test/sem-perfil', { ip: '2001:db8:aaaa:bbbb:ffff:eeee:dddd:cccc' }))
            .statusCode,
          429,
        );
        assert.equal(
          (await h.get('/test/sem-perfil', { ip: '2001:db8:aaaa:bbbc::1' })).statusCode,
          200,
        );
        assert.deepEqual((await h.keys()).map((key) => key.slice(h.prefix.length)).sort(), [
          'public:2001:db8:aaaa:bbbb::',
          'public:2001:db8:aaaa:bbbc::',
        ]);
      },
    );
  });
});

describe('janela e TTL no Redis', () => {
  it('a janela expira e o contador volta a zero', { timeout: 30_000 }, async () => {
    await withHarness(
      { profiles: profiles({ public: { max: 2, windowSeconds: 2 } }) },
      async (h) => {
        const startedAt = performance.now();
        assert.deepEqual(statuses(await repeat(h, 3, '/test/sem-perfil')), [200, 200, 429]);

        // Espera robusta: sonda até a janela expirar (nada de dormir um tempo fixo e torcer).
        let reopened = false;
        const deadline = performance.now() + 8_000;
        while (performance.now() < deadline) {
          await sleep(200);
          if ((await h.get('/test/sem-perfil')).statusCode === 200) {
            reopened = true;
            break;
          }
        }
        assert.ok(reopened, 'a janela não expirou');
        assert.ok(
          performance.now() - startedAt >= 1_500,
          'liberou antes de a janela de 2 s terminar',
        );
        // Janela nova: de novo o limite inteiro (esta já usou 1; a segunda passa, a terceira não).
        assert.equal((await h.get('/test/sem-perfil')).statusCode, 200);
        assert.equal((await h.get('/test/sem-perfil')).statusCode, 429);
      },
    );
  });

  it('toda chave criada tem TTL (nenhuma com PTTL -1), inclusive sob requisições concorrentes', async () => {
    await withHarness(
      {
        profiles: profiles({
          public: { max: 5, windowSeconds: 30 },
          admin: { max: 5, windowSeconds: 20 },
          webhook: { max: 5, windowSeconds: 10 },
        }),
      },
      async (h) => {
        const urls = ['/test/sem-perfil', '/admin/companies', '/test/webhook'];
        const ips = ['203.0.113.10', '203.0.113.11', '2001:db8:1:2::9'];
        const requests: Promise<LightMyRequestResponse>[] = [];
        for (let round = 0; round < 15; round += 1) {
          for (const url of urls) {
            for (const ip of ips) requests.push(h.get(url, { ip }));
          }
        }
        const responses = await Promise.all(requests);
        // 3 perfis x 3 IPs, 15 requisições concorrentes cada, limite 5.
        const counts = new Map<number, number>();
        for (const response of responses) {
          counts.set(response.statusCode, (counts.get(response.statusCode) ?? 0) + 1);
        }
        assert.equal(counts.get(429), 3 * 3 * 10, 'exatamente 10 de 15 recusadas por combinação');

        const keys = await h.keys();
        assert.equal(keys.length, 9);
        const windows: Record<string, number> = { public: 30, admin: 20, webhook: 10 };
        for (const key of keys) {
          const ttl = await mainRedis.client.pttl(key);
          const profile = key.slice(h.prefix.length).split(':')[0] ?? '';
          assert.ok(ttl > 0, `chave sem TTL (PTTL ${String(ttl)}): ${profile}`);
          assert.ok(
            ttl <= (windows[profile] ?? 0) * 1_000,
            `TTL acima da janela do perfil ${profile}`,
          );
        }
      },
    );
  });
});

describe('Redis fora (fail-open)', () => {
  it('porta fechada: requisições de todos os perfis passam rápido, com log error e métrica; sem IP no log', async () => {
    const closed = withPort(config.REDIS_URL, await getClosedPort());
    await withHarness(
      {
        redisUrl: closed,
        waitReady: false,
        profiles: profiles({
          public: { max: 1, windowSeconds: 60 },
          admin: { max: 1, windowSeconds: 60 },
          webhook: { max: 1, windowSeconds: 60 },
        }),
      },
      async (h) => {
        const ip = '203.0.113.99';
        const urls = ['/test/sem-perfil', '/admin/companies', '/test/webhook'];
        let sent = 0;
        // Duas voltas por perfil: com limite 1, a segunda seria 429 se o limiter estivesse ativo.
        for (let round = 0; round < 2; round += 1) {
          for (const url of urls) {
            const startedAt = performance.now();
            const response = await h.get(url, { ip });
            const elapsed = performance.now() - startedAt;
            sent += 1;
            assert.notEqual(response.statusCode, 429, `${url} foi limitado com o Redis fora`);
            assert.ok(
              elapsed < REDIS_TIMEOUT_MS + 750,
              `${url} demorou ${String(Math.round(elapsed))} ms`,
            );
          }
        }

        const errorLines = h.logs.lines().filter((line) => String(line.msg).includes('fail-open'));
        assert.equal(errorLines.length, sent);
        for (const line of errorLines) assert.equal(line.level, 50);
        assert.match(
          await h.metrics.render(),
          new RegExp(`rate_limit_store_errors_total ${String(sent)}\\b`),
        );
        assert.ok(!h.logs.raw().includes(ip), 'IP apareceu em log');
        assert.ok(!h.logs.raw().includes(h.prefix), 'chave apareceu em log');
      },
    );
  });

  it(
    'Redis lento ou fora e depois de volta: passa dentro do prazo e o limite volta a valer',
    { timeout: 60_000 },
    async () => {
      const redisUrl = new URL(config.REDIS_URL);
      const proxy = new ToggleProxy(redisUrl.hostname, Number(redisUrl.port || '6379'));
      await proxy.start();
      const viaProxy = new URL(config.REDIS_URL);
      viaProxy.hostname = '127.0.0.1';
      viaProxy.port = String(proxy.listeningPort);

      try {
        await withHarness(
          {
            redisUrl: viaProxy.toString(),
            profiles: profiles({ public: { max: 1, windowSeconds: 60 } }),
          },
          async (h) => {
            const count = async (): Promise<number> => {
              const body = await h.metrics.render();
              const match = /^rate_limit_store_errors_total (\d+)$/m.exec(body);
              return Number(match?.[1] ?? 0);
            };

            // 1. Normal: o limite vale.
            assert.deepEqual(
              statuses(await repeat(h, 2, '/test/sem-perfil', { ip: '203.0.113.21' })),
              [200, 429],
            );
            assert.equal(await count(), 0);

            // 2. Lento: o Redis aceita e nunca responde. Estoura o commandTimeout e a requisição passa.
            proxy.mode = 'blackhole';
            const slowStart = performance.now();
            const slow = await h.get('/test/sem-perfil', { ip: '203.0.113.22' });
            const slowElapsed = performance.now() - slowStart;
            assert.equal(slow.statusCode, 200);
            assert.ok(
              slowElapsed >= REDIS_TIMEOUT_MS * 0.6,
              `voltou cedo demais: ${String(slowElapsed)} ms`,
            );
            assert.ok(slowElapsed < REDIS_TIMEOUT_MS + 1_000, `demorou ${String(slowElapsed)} ms`);
            assert.equal(await count(), 1);

            // 3. Fora: conexões derrubadas e porta recusando. Passa na hora, mesmo acima do limite.
            await proxy.stop();
            for (const ip of ['203.0.113.23', '203.0.113.23', '203.0.113.23']) {
              const startedAt = performance.now();
              const response = await h.get('/test/sem-perfil', { ip });
              assert.equal(response.statusCode, 200);
              assert.ok(performance.now() - startedAt < REDIS_TIMEOUT_MS + 750);
            }
            assert.ok((await count()) >= 4);

            // 4. De volta: a conexão reconecta sozinha e o limite volta a valer.
            proxy.mode = 'forward';
            await proxy.start();
            assert.ok(await h.handle.waitUntilReady(15_000), 'a conexão não voltou');
            assert.deepEqual(
              statuses(await repeat(h, 3, '/test/sem-perfil', { ip: '203.0.113.24' })),
              [200, 429, 429],
            );
          },
        );
      } finally {
        await proxy.stop();
      }
    },
  );
});

describe('métricas e logs', () => {
  it('rate_limit_rejected_total{profile} aparece em /metrics após um 429, sem IP, chave ou id; o 429 entra no log e nas métricas HTTP', async () => {
    await withHarness(
      { profiles: profiles({ admin: { max: 1, windowSeconds: 60 } }) },
      async (h) => {
        const ip = '203.0.113.150';
        await repeat(h, 3, '/admin/companies', { ip });
        const response = await h.get('/metrics', {
          headers: { authorization: `Bearer ${METRICS_TOKEN}` },
        });
        assert.equal(response.statusCode, 200);
        const body = response.body;
        assert.match(body, /rate_limit_rejected_total\{profile="admin"\} 2\b/);
        assert.doesNotMatch(body, /rate_limit_rejected_total\{profile="webhook"\}/);
        assert.match(
          body,
          /http_requests_total\{method="GET",route="\/admin\/companies",status_class="4xx"\} 3/,
        );
        assert.ok(!body.includes(ip));
        assert.ok(!body.includes(h.prefix));
        assert.doesNotMatch(body, /\bip=|key=|companyId|membershipId/i);

        const limited = h.logs
          .lines()
          .filter((line) => line.statusCode === 429 && line.msg === 'requisição concluída');
        assert.equal(limited.length, 2);
        for (const line of limited) {
          assert.equal(line.level, 40, 'o 429 sai como warn');
          assert.equal(line.route, '/admin/companies');
        }
        // Nenhum IP em nenhuma linha de log gerada por esta spec.
        assert.ok(!h.logs.raw().includes(ip), 'IP apareceu em log');
        assert.ok(!h.logs.raw().includes(h.adminToken));
      },
    );
  });
});

describe('TRUST_PROXY', () => {
  const PROXY_IP = '10.0.0.1';
  // Lista de proxies confiáveis (o proxy-addr valida o peer imediato; inteiro não existe mais).
  const PROXIES = ['10.0.0.0/8'] as const;
  const quota1 = { public: { max: 1, windowSeconds: 60 } };

  it('false: X-Forwarded-For é ignorado (dois valores diferentes compartilham a cota do socket)', async () => {
    await withHarness({ trustProxy: false, profiles: profiles(quota1) }, async (h) => {
      const a = await h.get('/test/sem-perfil', {
        ip: PROXY_IP,
        headers: { 'x-forwarded-for': '198.51.100.1' },
      });
      const b = await h.get('/test/sem-perfil', {
        ip: PROXY_IP,
        headers: { 'x-forwarded-for': '198.51.100.2' },
      });
      assert.equal(a.statusCode, 200);
      assert.equal(b.statusCode, 429);
      assert.deepEqual(
        (await h.keys()).map((key) => key.slice(h.prefix.length)),
        [`public:${PROXY_IP}`],
      );
    });
  });

  it('lista: o IP vem do X-Forwarded-For acrescentado pelo proxy; valor forjado à esquerda não muda a chave', async () => {
    await withHarness({ trustProxy: PROXIES, profiles: profiles(quota1) }, async (h) => {
      const viaProxy = (forwarded: string): Promise<LightMyRequestResponse> =>
        h.get('/test/sem-perfil', { ip: PROXY_IP, headers: { 'x-forwarded-for': forwarded } });

      // O proxy acrescenta o IP real (198.51.100.1) ao fim; a empresa forjou o começo.
      assert.equal((await viaProxy('9.9.9.9, 198.51.100.1')).statusCode, 200);
      // Outro valor forjado à esquerda, mesmo IP real: mesma chave, então recusado.
      assert.equal((await viaProxy('8.8.8.8, 7.7.7.7, 198.51.100.1')).statusCode, 429);
      // Sem forjar nada, mesmo IP real: também a mesma chave.
      assert.equal((await viaProxy('198.51.100.1')).statusCode, 429);

      // O atacante (IP real 198.51.100.66) tenta esgotar a cota da vítima forjando o IP dela:
      // a chave é a dele; a vítima segue com a cota intacta.
      assert.equal((await viaProxy('198.51.100.2, 198.51.100.66')).statusCode, 200);
      assert.equal((await viaProxy('198.51.100.2, 198.51.100.66')).statusCode, 429);
      assert.equal((await viaProxy('198.51.100.2')).statusCode, 200);

      assert.deepEqual((await h.keys()).map((key) => key.slice(h.prefix.length)).sort(), [
        'public:198.51.100.1',
        'public:198.51.100.2',
        'public:198.51.100.66',
      ]);
    });
  });

  it('lista: X-Forwarded-For malformado usa o endereço do socket e nunca lança', async () => {
    await withHarness({ trustProxy: PROXIES, profiles: profiles(quota1) }, async (h) => {
      for (const forwarded of ['garbage', '1.1.1.1, not-an-ip', '1.2.3.4.5', '[::1', ',,,']) {
        const response = await h.get('/test/sem-perfil', {
          ip: `10.1.${String(forwarded.length)}.1`,
          headers: { 'x-forwarded-for': forwarded },
        });
        assert.equal(response.statusCode, 200, forwarded);
      }
      // A chave caiu no socket, não em "garbage".
      for (const key of await h.keys()) assert.match(key, /public:10\.1\.\d+\.1$/);
    });
  });

  it('lista: porta e colchetes no X-Forwarded-For são normalizados antes de virar chave', async () => {
    await withHarness({ trustProxy: PROXIES, profiles: profiles(quota1) }, async (h) => {
      const viaProxy = (forwarded: string): Promise<LightMyRequestResponse> =>
        h.get('/test/sem-perfil', { ip: PROXY_IP, headers: { 'x-forwarded-for': forwarded } });
      assert.equal((await viaProxy('198.51.100.5:51000')).statusCode, 200);
      assert.equal((await viaProxy('198.51.100.5')).statusCode, 429);
      assert.equal((await viaProxy('[2001:db8:1:2::7]:443')).statusCode, 200);
      assert.equal((await viaProxy('2001:db8:1:2::8')).statusCode, 429);
    });
  });

  it('lista de CIDRs: só proxies listados são confiados', async () => {
    await withHarness({ trustProxy: PROXIES, profiles: profiles(quota1) }, async (h) => {
      // Proxy listado (10.0.0.1): o X-Forwarded-For vale.
      const trusted = (forwarded: string): Promise<LightMyRequestResponse> =>
        h.get('/test/sem-perfil', { ip: PROXY_IP, headers: { 'x-forwarded-for': forwarded } });
      assert.equal((await trusted('198.51.100.1')).statusCode, 200);
      assert.equal((await trusted('9.9.9.9, 198.51.100.1')).statusCode, 429);
      assert.equal((await trusted('198.51.100.2')).statusCode, 200);

      // Origem fora da lista (192.0.2.50): o cabeçalho é ignorado, vale o socket.
      const direct = (forwarded: string): Promise<LightMyRequestResponse> =>
        h.get('/test/sem-perfil', { ip: '192.0.2.50', headers: { 'x-forwarded-for': forwarded } });
      assert.equal((await direct('198.51.100.77')).statusCode, 200);
      assert.equal((await direct('198.51.100.78')).statusCode, 429);
      assert.ok((await h.keys()).some((key) => key.endsWith('public:192.0.2.50')));
    });
  });

  it('lista: conexão direta de IP fora da lista com X-Forwarded-For forjado cai no IP do socket e não esgota a cota de outro IP', async () => {
    await withHarness({ trustProxy: PROXIES, profiles: profiles(quota1) }, async (h) => {
      const attacker = '192.0.2.66';
      const victim = '198.51.100.40';
      const forge = (): Promise<LightMyRequestResponse> =>
        h.get('/test/ip', { ip: attacker, headers: { 'x-forwarded-for': victim } });
      // O cabeçalho é ignorado: request.ip é o socket do atacante.
      assert.equal((await forge()).json<{ ip: string }>().ip, attacker);
      // A cota consumida (e esgotada) é a do atacante...
      assert.equal((await forge()).statusCode, 429);
      // ...e a da vítima segue intacta, vinda pelo proxy confiável ou direto.
      const viaProxy = await h.get('/test/sem-perfil', {
        ip: PROXY_IP,
        headers: { 'x-forwarded-for': victim },
      });
      assert.equal(viaProxy.statusCode, 200);
      assert.deepEqual((await h.keys()).map((key) => key.slice(h.prefix.length)).sort(), [
        `public:${attacker}`,
        `public:${victim}`,
      ]);
    });
  });

  it('true: confia em toda a cadeia (o chamador escolhe o IP; por isso só para ambiente fechado)', async () => {
    await withHarness({ trustProxy: true, profiles: profiles(quota1) }, async (h) => {
      const response = await h.get('/test/ip', {
        ip: PROXY_IP,
        headers: { 'x-forwarded-for': '198.51.100.9, 10.0.0.5' },
      });
      assert.equal(response.json<{ ip: string }>().ip, '198.51.100.9');
    });
  });
});
