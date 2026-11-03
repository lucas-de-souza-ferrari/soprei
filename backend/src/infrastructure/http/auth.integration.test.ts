import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { AttendanceService } from '../../application/attendance/attendance.service.js';
import { ClientService } from '../../application/clients/client.service.js';
import type { Client } from '../../domain/index.js';
import { Result } from '../../shared/types/index.js';
import { bearer } from '../../test-support/in-memory-auth.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { captureLogs, type LogCapture } from '../../test-support/log-capture.js';
import { TestKeyspace } from '../../test-support/test-keyspace.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import { ToggleProxy } from '../../test-support/toggle-proxy.js';
import { createAuthRedis, type AuthRedisHandle } from '../auth/auth-redis.js';
import { createAuthComponents, type AuthComponents } from '../auth/create-auth.js';
import { ScryptPasswordHasher } from '../auth/scrypt-password-hasher.js';
import { createRedis, type RedisHandle } from '../cache/redis.client.js';
import { createRateLimitRedis, type RateLimitRedisHandle } from '../cache/rate-limit-redis.js';
import {
  createDatabase,
  type Database,
  PrismaClientRepository,
  PrismaConversationRepository,
  PrismaAttendanceUnitOfWork,
  PrismaMessageRepository,
} from '../database/index.js';
import { MockLlmProvider } from '../external-apis/llm/mock-llm.provider.js';
import { createMetrics, type Metrics } from '../metrics/index.js';
import { type RateLimitProfiles } from './rate-limit/rate-limit.js';
import { buildServer } from './server.js';

const config = loadIntegrationConfig();
const keyspace = new TestKeyspace();
const METRICS_TOKEN = `it-${randomUUID()}-${randomUUID()}`;
const PASSWORD = `senha-secreta-${randomUUID()}`;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Hasher barato (custo baixo) que conta as verificações. */
class CountingHasher extends ScryptPasswordHasher {
  verifyCalls = 0;
  constructor() {
    super({ cost: { N: 1024, r: 8, p: 1 } });
  }
  override verify(password: string, storedHash: string): Promise<boolean> {
    this.verifyCalls += 1;
    return super.verify(password, storedHash);
  }
}

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

let database: Database;
let tenants: TestTenants;
let main: RedisHandle;

before(() => {
  database = createDatabase(config, captureLogs().logger);
  tenants = new TestTenants(database.prisma);
  main = createRedis(config, captureLogs().logger);
});

after(async () => {
  try {
    await tenants.cleanup();
    await database.prisma.platformAdmin.deleteMany({
      where: { email: { endsWith: '@auth-it.test' } },
    });
    await keyspace.cleanup(main.client);
  } finally {
    await main.close();
    await database.close();
  }
});

interface Harness {
  readonly app: FastifyInstance;
  readonly logs: LogCapture;
  readonly metrics: Metrics;
  readonly auth: AuthComponents;
  readonly hasher: CountingHasher;
  readonly authRedis: AuthRedisHandle;
  readonly rateRedis: RateLimitRedisHandle;
  readonly attendanceCalls: { count: number };
  close(): Promise<void>;
}

async function createHarness(
  options: {
    authRedisUrl?: string;
    rateRedisUrl?: string;
    profiles?: RateLimitProfiles;
    maxFailures?: number;
    accessTtl?: number;
  } = {},
): Promise<Harness> {
  const logs = captureLogs();
  const metrics = createMetrics();
  const hasher = new CountingHasher();
  const authRedis = createAuthRedis(
    { REDIS_URL: options.authRedisUrl ?? config.REDIS_URL, AUTH_REDIS_TIMEOUT_MS: 300 },
    logs.logger,
  );
  const rateRedis = createRateLimitRedis(
    { REDIS_URL: options.rateRedisUrl ?? config.REDIS_URL, RATE_LIMIT_REDIS_TIMEOUT_MS: 300 },
    logs.logger,
  );
  assert.ok(await authRedis.waitUntilReady(5_000));
  assert.ok(await rateRedis.waitUntilReady(5_000));
  const authPrefix = keyspace.scopedPrefix(`e2e-${randomUUID()}`);
  const ratePrefix = keyspace.scopedPrefix(`rl-${randomUUID()}`);
  const auth = createAuthComponents({
    config: {
      ...config,
      AUTH_REDIS_PREFIX: authPrefix,
      AUTH_LOGIN_MAX_FAILURES: options.maxFailures ?? 3,
      AUTH_ACCESS_TTL_SECONDS: options.accessTtl ?? config.AUTH_ACCESS_TTL_SECONDS,
    },
    logger: logs.logger,
    prisma: database.prisma,
    authRedis,
    metrics,
    hasher,
  });
  const clientRepository = new PrismaClientRepository(database.prisma);
  const llm = new MockLlmProvider({ recordCalls: true });
  const attendanceCalls = { count: 0 };
  const attendance = new AttendanceService({
    clients: clientRepository,
    conversations: new PrismaConversationRepository(database.prisma),
    messages: new PrismaMessageRepository(database.prisma),
    unitOfWork: new PrismaAttendanceUnitOfWork(database.prisma),
    llm: {
      name: 'mock',
      generate: (input, opts) => {
        attendanceCalls.count += 1;
        return llm.generate(input, opts);
      },
    },
    logger: logs.logger,
    metrics,
    options: { llmTimeoutMs: 1_000, inFlightTimeoutMs: 60_000 },
  });
  const app = buildServer({
    logger: logs.logger,
    readiness: {
      database: () => database.check(),
      redis: () => Promise.resolve(Result.ok(undefined)),
    },
    metrics,
    metricsToken: METRICS_TOKEN,
    auth: auth.service,
    admin: { clients: new ClientService(clientRepository), attendance },
    rateLimit: {
      redis: rateRedis.client,
      profiles: options.profiles ?? profiles(),
      keyPrefix: ratePrefix,
    },
  });
  await app.ready();
  return {
    app,
    logs,
    metrics,
    auth,
    hasher,
    authRedis,
    rateRedis,
    attendanceCalls,
    async close() {
      try {
        await app.close();
      } finally {
        await authRedis.close();
        await rateRedis.close();
      }
    },
  };
}

async function withHarness(
  options: Parameters<typeof createHarness>[0],
  body: (harness: Harness) => Promise<void>,
): Promise<void> {
  const harness = await createHarness(options);
  try {
    await body(harness);
  } finally {
    await harness.close();
  }
}

const emailFor = (label: string): string =>
  `${label}-${randomBytes(5).toString('hex')}@auth-it.test`;

async function createUser(
  h: Harness,
  client: Client,
  email: string,
  role: 'OWNER' | 'AGENT' = 'OWNER',
): Promise<void> {
  await h.auth.users.create(client.id, {
    email,
    passwordHash: await h.auth.hasher.hash(PASSWORD),
    role,
  });
}

const postJson = (
  h: Harness,
  url: string,
  payload: object,
  extra: { ip?: string; headers?: Record<string, string> } = {},
): Promise<LightMyRequestResponse> =>
  h.app.inject({
    method: 'POST',
    url,
    payload,
    remoteAddress: extra.ip ?? '203.0.113.10',
    ...(extra.headers === undefined ? {} : { headers: extra.headers }),
  });

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

async function login(h: Harness, client: Client, email: string, ip?: string): Promise<Tokens> {
  const response = await postJson(
    h,
    '/auth/login',
    { clientSlug: client.slug, email, password: PASSWORD },
    ip === undefined ? {} : { ip },
  );
  assert.equal(response.statusCode, 200, response.body);
  return response.json<Tokens>();
}

const stable = (response: LightMyRequestResponse): unknown => {
  const body = response.json<{ error: Record<string, unknown> }>();
  return { status: response.statusCode, error: { ...body.error, requestId: 'x' } };
};

describe('isolamento de ponta a ponta nas rotas /admin (dois clientes, banco e Redis reais)', () => {
  it('o usuário do cliente A com o :clientId do B recebe 404 idêntico ao de cliente inexistente, sem tocar em dados do B', async () => {
    await withHarness({}, async (h) => {
      const clientA = await tenants.createClient('e2e-a');
      const clientB = await tenants.createClient('e2e-b');
      const emailA = emailFor('a');
      await createUser(h, clientA, emailA);
      await createUser(h, clientB, emailFor('b'));
      const tokenA = await login(h, clientA, emailA);

      const secretText = `texto-secreto-${randomUUID()}`;
      const attempts = [
        (clientId: string) =>
          h.app.inject({
            method: 'POST',
            url: `/admin/clients/${clientId}/messages`,
            headers: bearer(tokenA.accessToken),
            payload: { contactRef: 'c1', text: secretText },
          }),
        (clientId: string) =>
          h.app.inject({
            method: 'GET',
            url: `/admin/clients/${clientId}/conversations`,
            headers: bearer(tokenA.accessToken),
          }),
        (clientId: string) =>
          h.app.inject({
            method: 'GET',
            url: `/admin/clients/${clientId}/conversations/${randomUUID()}/messages`,
            headers: bearer(tokenA.accessToken),
          }),
      ];
      for (const attempt of attempts) {
        const cross = await attempt(clientB.id);
        const ghost = await attempt(randomUUID());
        const malformed = await attempt('nao-e-uuid');
        assert.equal(cross.statusCode, 404);
        assert.deepEqual(stable(cross), stable(ghost));
        assert.deepEqual(stable(cross), stable(malformed));
        assert.ok(!cross.body.includes(clientB.id));
      }
      // Nada foi gravado nem lido no B, e o LLM nem foi chamado.
      assert.equal(
        await database.prisma.conversation.count({ where: { clientId: clientB.id } }),
        0,
      );
      assert.equal(await database.prisma.message.count({ where: { clientId: clientB.id } }), 0);
      assert.equal(
        await database.prisma.conversation.count({ where: { clientId: clientA.id } }),
        0,
      );
      assert.equal(h.attendanceCalls.count, 0);

      // Com o :clientId do A funciona, e o ClientId repassado ao service é o do token.
      const ok = await h.app.inject({
        method: 'POST',
        url: `/admin/clients/${clientA.id}/messages`,
        headers: bearer(tokenA.accessToken),
        payload: { contactRef: 'c1', text: secretText },
      });
      assert.equal(ok.statusCode, 201);
      assert.equal(
        await database.prisma.conversation.count({ where: { clientId: clientA.id } }),
        1,
      );
      assert.equal(
        await database.prisma.conversation.count({ where: { clientId: clientB.id } }),
        0,
      );
      // O :clientId em maiúsculas é o mesmo cliente (ids de UUID são comparados em minúsculas).
      const upper = await h.app.inject({
        method: 'GET',
        url: `/admin/clients/${clientA.id.toUpperCase()}/conversations`,
        headers: bearer(tokenA.accessToken),
      });
      assert.equal(upper.statusCode, 200);
      // O texto da mensagem não foi para o log.
      assert.ok(!h.logs.raw().includes(secretText));
    });
  });

  it('User no CRUD de clientes: 403; PlatformAdmin nas rotas de atendimento: 403; sem token ou expirado: 401', async () => {
    await withHarness({}, async (h) => {
      const client = await tenants.createClient('e2e-roles');
      const email = emailFor('roles');
      await createUser(h, client, email);
      const user = await login(h, client, email);
      const adminEmail = emailFor('plataforma');
      await h.auth.platformAdmins.create({
        email: adminEmail,
        passwordHash: await h.auth.hasher.hash(PASSWORD),
      });
      const platformLogin = await postJson(h, '/auth/platform/login', {
        email: adminEmail,
        password: PASSWORD,
      });
      assert.equal(platformLogin.statusCode, 200);
      const platform = platformLogin.json<Tokens>();

      const crud = await h.app.inject({
        method: 'GET',
        url: '/admin/clients',
        headers: bearer(user.accessToken),
      });
      assert.equal(crud.statusCode, 403);
      const crudOk = await h.app.inject({
        method: 'GET',
        url: '/admin/clients',
        headers: bearer(platform.accessToken),
      });
      assert.equal(crudOk.statusCode, 200);
      for (const url of [
        `/admin/clients/${client.id}/conversations`,
        `/admin/clients/${client.id}/conversations/${randomUUID()}/messages`,
      ]) {
        const response = await h.app.inject({
          method: 'GET',
          url,
          headers: bearer(platform.accessToken),
        });
        assert.equal(response.statusCode, 403, url);
      }
      const post = await h.app.inject({
        method: 'POST',
        url: `/admin/clients/${client.id}/messages`,
        headers: bearer(platform.accessToken),
        payload: { contactRef: 'c', text: 'oi' },
      });
      assert.equal(post.statusCode, 403);
      for (const url of [
        '/admin/clients',
        `/admin/clients/${client.id}/conversations`,
        '/auth/me',
      ]) {
        assert.equal((await h.app.inject({ method: 'GET', url })).statusCode, 401, url);
      }
    });
  });

  it('logout-all e logout derrubam o access token ainda dentro do prazo (Redis real)', async () => {
    await withHarness({}, async (h) => {
      const client = await tenants.createClient('e2e-revoke');
      const email = emailFor('rev');
      await createUser(h, client, email);
      const one = await login(h, client, email);
      await sleep(1_100); // o `nbf` compara segundos: o token novo precisa nascer depois
      const two = await login(h, client, email);
      const me = (token: string) =>
        h.app.inject({ method: 'GET', url: '/auth/me', headers: bearer(token) });
      assert.equal((await me(one.accessToken)).statusCode, 200);
      const logout = await postJson(h, '/auth/logout', { refreshToken: two.refreshToken });
      assert.equal(logout.statusCode, 204);
      assert.equal((await me(two.accessToken)).statusCode, 401);
      assert.equal((await me(one.accessToken)).statusCode, 200, 'a outra sessão não foi afetada');
      const all = await h.app.inject({
        method: 'POST',
        url: '/auth/logout-all',
        headers: bearer(one.accessToken),
      });
      assert.equal(all.statusCode, 204);
      assert.equal((await me(one.accessToken)).statusCode, 401);
    });
  });
});

describe('limites de taxa e falha fechada (login e refresh)', () => {
  it('429 por IP ao exceder RATE_LIMIT_LOGIN_MAX (login e platform/login) e RATE_LIMIT_REFRESH_MAX (refresh e logout)', async () => {
    await withHarness(
      {
        profiles: profiles({
          login: { max: 2, windowSeconds: 60 },
          refresh: { max: 2, windowSeconds: 60 },
        }),
      },
      async (h) => {
        const wrongLogin = {
          clientSlug: 'qualquer-slug',
          email: 'x@auth-it.test',
          password: PASSWORD,
        };
        const statuses = async (url: string, body: object, ip: string): Promise<number[]> => {
          const result: number[] = [];
          for (let i = 0; i < 4; i += 1)
            result.push((await postJson(h, url, body, { ip })).statusCode);
          return result;
        };
        assert.deepEqual(
          await statuses('/auth/login', wrongLogin, '198.51.100.1'),
          [401, 401, 429, 429],
        );
        // O contador do perfil login é um só para as duas rotas de login (mesmo IP).
        const platform = await postJson(
          h,
          '/auth/platform/login',
          { email: 'x@auth-it.test', password: PASSWORD },
          { ip: '198.51.100.1' },
        );
        assert.equal(platform.statusCode, 429);
        assert.deepEqual(
          await statuses(
            '/auth/platform/login',
            { email: 'x@auth-it.test', password: PASSWORD },
            '198.51.100.2',
          ),
          [401, 401, 429, 429],
        );
        const refresh = { refreshToken: `platform.${randomUUID()}.${'a'.repeat(64)}` };
        assert.deepEqual(
          await statuses('/auth/refresh', refresh, '198.51.100.3'),
          [401, 401, 429, 429],
        );
        const logout = await postJson(h, '/auth/logout', refresh, { ip: '198.51.100.3' });
        assert.equal(logout.statusCode, 429, 'refresh e logout dividem o perfil');
        // Outro IP segue livre; o 429 traz Retry-After e o código RATE_LIMITED.
        const other = await postJson(h, '/auth/refresh', refresh, { ip: '198.51.100.4' });
        assert.equal(other.statusCode, 401);
        const limited = await postJson(h, '/auth/login', wrongLogin, { ip: '198.51.100.1' });
        assert.equal(limited.statusCode, 429);
        assert.ok(Number(limited.headers['retry-after']) >= 1);
        assert.equal(limited.json<{ error: { code: string } }>().error.code, 'RATE_LIMITED');
        assert.match(
          await h.metrics.render(),
          /rate_limit_rejected_total\{profile="login"\} [1-9]/,
        );
        assert.match(
          await h.metrics.render(),
          /rate_limit_rejected_total\{profile="refresh"\} [1-9]/,
        );
      },
    );
  });

  it(
    'com o Redis do limiter fora, login e refresh respondem 503, não verificam senha e não emitem token; as outras rotas seguem em fail-open',
    { timeout: 60_000 },
    async () => {
      const url = new URL(config.REDIS_URL);
      const proxy = new ToggleProxy(url.hostname, Number(url.port || '6379'));
      await proxy.start();
      const viaProxy = new URL(config.REDIS_URL);
      viaProxy.hostname = '127.0.0.1';
      viaProxy.port = String(proxy.listeningPort);
      try {
        await withHarness({ rateRedisUrl: viaProxy.toString() }, async (h) => {
          const client = await tenants.createClient('e2e-limiter-down');
          const email = emailFor('down');
          await createUser(h, client, email);
          const tokens = await login(h, client, email);
          const body = { clientSlug: client.slug, email, password: PASSWORD };
          const refresh = { refreshToken: tokens.refreshToken };

          for (const mode of ['blackhole', 'stop'] as const) {
            if (mode === 'blackhole') proxy.mode = 'blackhole';
            else {
              proxy.mode = 'forward';
              await proxy.stop();
            }
            const before = h.hasher.verifyCalls;
            const loginResponse = await postJson(h, '/auth/login', body);
            assert.equal(loginResponse.statusCode, 503, mode);
            assert.equal(
              loginResponse.json<{ error: { code: string } }>().error.code,
              'SERVICE_UNAVAILABLE',
            );
            assert.ok(!loginResponse.body.includes('accessToken'));
            assert.equal(
              (await postJson(h, '/auth/platform/login', { email, password: PASSWORD })).statusCode,
              503,
            );
            const refreshResponse = await postJson(h, '/auth/refresh', refresh);
            assert.equal(refreshResponse.statusCode, 503, mode);
            assert.ok(!refreshResponse.body.includes('refreshToken'));
            assert.equal((await postJson(h, '/auth/logout', refresh)).statusCode, 503);
            assert.equal(h.hasher.verifyCalls, before, 'nenhuma senha foi verificada');
            // O refresh não foi consumido: depois da queda ele segue valendo (a sessão não mudou).
            // Rotas dos demais perfis seguem em fail-open (autenticam normalmente).
            const me = await h.app.inject({
              method: 'GET',
              url: '/auth/me',
              headers: bearer(tokens.accessToken),
            });
            assert.equal(me.statusCode, 200, `${mode}: o perfil admin segue em fail-open`);
          }
          await proxy.start();
          const deadline = Date.now() + 15_000;
          let status = 0;
          while (Date.now() < deadline) {
            status = (await postJson(h, '/auth/refresh', refresh)).statusCode;
            if (status === 200) break;
            await sleep(100);
          }
          assert.equal(status, 200, 'o refresh intacto volta a funcionar quando o Redis volta');
        });
      } finally {
        await proxy.stop();
      }
    },
  );

  it(
    'com o Redis das sessões fora: login, refresh, logout, logout-all e rotas autenticadas respondem 503',
    { timeout: 60_000 },
    async () => {
      const url = new URL(config.REDIS_URL);
      const proxy = new ToggleProxy(url.hostname, Number(url.port || '6379'));
      await proxy.start();
      const viaProxy = new URL(config.REDIS_URL);
      viaProxy.hostname = '127.0.0.1';
      viaProxy.port = String(proxy.listeningPort);
      try {
        await withHarness({ authRedisUrl: viaProxy.toString() }, async (h) => {
          const client = await tenants.createClient('e2e-auth-down');
          const email = emailFor('adown');
          await createUser(h, client, email);
          const tokens = await login(h, client, email);
          const logsBefore = h.logs.lines().length;
          await proxy.stop();
          const before = h.hasher.verifyCalls;
          const responses = [
            await postJson(h, '/auth/login', {
              clientSlug: client.slug,
              email,
              password: PASSWORD,
            }),
            await postJson(h, '/auth/refresh', { refreshToken: tokens.refreshToken }),
            await postJson(h, '/auth/logout', { refreshToken: tokens.refreshToken }),
            await h.app.inject({
              method: 'POST',
              url: '/auth/logout-all',
              headers: bearer(tokens.accessToken),
            }),
            await h.app.inject({
              method: 'GET',
              url: '/auth/me',
              headers: bearer(tokens.accessToken),
            }),
            await h.app.inject({
              method: 'GET',
              url: `/admin/clients/${client.id}/conversations`,
              headers: bearer(tokens.accessToken),
            }),
          ];
          for (const response of responses) {
            assert.equal(response.statusCode, 503, response.body);
            assert.equal(
              response.json<{ error: { code: string } }>().error.code,
              'SERVICE_UNAVAILABLE',
            );
          }
          assert.equal(h.hasher.verifyCalls, before, 'login com o Redis fora não verifica a senha');
          // O erro do ioredis não vazou: nem chave, nem id, nem token no log da queda.
          const newLogs = h.logs
            .lines()
            .slice(logsBefore)
            .map((line) => JSON.stringify(line))
            .join('\n');
          for (const secret of [tokens.accessToken, tokens.refreshToken, email, PASSWORD]) {
            assert.ok(!newLogs.includes(secret), 'log da queda do Redis vazou dado');
          }
          assert.ok(!newLogs.includes('sess:'), 'chave do Redis no log');
          await proxy.start();
        });
      } finally {
        await proxy.stop();
      }
    },
  );
});

describe('privacidade e métricas de ponta a ponta', () => {
  it('senha, e-mail, access token, refresh token e JWT_SECRET nunca aparecem em log, métrica nem corpo de erro', async () => {
    await withHarness({ maxFailures: 2 }, async (h) => {
      const client = await tenants.createClient('e2e-priv');
      const email = emailFor('segredo');
      await createUser(h, client, email);
      const responses: LightMyRequestResponse[] = [];
      const good = await postJson(h, '/auth/login', {
        clientSlug: client.slug,
        email,
        password: PASSWORD,
      });
      assert.equal(good.statusCode, 200);
      const tokens = good.json<Tokens>();
      const wrongPassword = `errada-${randomUUID()}`;
      responses.push(
        await postJson(h, '/auth/login', {
          clientSlug: client.slug,
          email,
          password: wrongPassword,
        }),
        await postJson(h, '/auth/login', {
          clientSlug: client.slug,
          email,
          password: wrongPassword,
        }),
        await postJson(h, '/auth/login', { clientSlug: client.slug, email, password: PASSWORD }), // bloqueada
        await postJson(h, '/auth/login', {
          clientSlug: client.slug,
          email: 'nao-e-email',
          password: PASSWORD,
        }), // 400
        await postJson(h, '/auth/login', {
          clientSlug: client.slug,
          email,
          password: 'a'.repeat(200),
        }), // 400
      );
      const refreshed = await postJson(h, '/auth/refresh', { refreshToken: tokens.refreshToken });
      assert.equal(refreshed.statusCode, 200);
      responses.push(refreshed);
      responses.push(await postJson(h, '/auth/refresh', { refreshToken: tokens.refreshToken })); // reuso
      responses.push(
        await postJson(h, '/auth/logout', { refreshToken: refreshed.json<Tokens>().refreshToken }),
      );
      for (const header of [
        undefined,
        'Bearer a.b.c',
        `Bearer ${tokens.accessToken}`,
        'Basic xyz',
      ]) {
        responses.push(
          await h.app.inject({
            method: 'GET',
            url: '/auth/me',
            ...(header === undefined ? {} : { headers: { authorization: header } }),
          }),
        );
      }
      const metrics = await h.metrics.render();
      const secrets = [
        PASSWORD,
        wrongPassword,
        email,
        tokens.accessToken,
        tokens.refreshToken,
        refreshed.json<Tokens>().accessToken,
        refreshed.json<Tokens>().refreshToken,
        config.JWT_SECRET,
        client.slug,
      ];
      const logs = h.logs.raw();
      assert.ok(logs.length > 0);
      for (const secret of secrets) {
        assert.ok(!logs.includes(secret), `log vazou ${secret.slice(0, 14)}`);
        assert.ok(!metrics.includes(secret), `métrica vazou ${secret.slice(0, 14)}`);
        for (const response of responses.filter((r) => r.statusCode >= 400)) {
          assert.ok(!response.body.includes(secret), `erro vazou ${secret.slice(0, 14)}`);
        }
      }
      // Nem o hash da senha, em lugar algum.
      const hash =
        (await h.auth.users.findCredentialsByEmail(client.id, email))?.passwordHash ?? 'x';
      assert.ok(hash.startsWith('scrypt$'));
      assert.ok(!logs.includes(hash) && !metrics.includes(hash));
    });
  });

  it('/metrics expõe os contadores auth_* com labels fixos e nenhum id, e-mail ou IP', async () => {
    await withHarness({ maxFailures: 2 }, async (h) => {
      const client = await tenants.createClient('e2e-metrics');
      const email = emailFor('metricas');
      await createUser(h, client, email);
      const tokens = await login(h, client, email, '192.0.2.77');
      await postJson(
        h,
        '/auth/login',
        { clientSlug: client.slug, email, password: 'errada-errada-12' },
        { ip: '192.0.2.77' },
      );
      await postJson(
        h,
        '/auth/refresh',
        { refreshToken: tokens.refreshToken },
        { ip: '192.0.2.77' },
      );
      await postJson(
        h,
        '/auth/refresh',
        { refreshToken: tokens.refreshToken },
        { ip: '192.0.2.77' },
      );
      await h.app.inject({ method: 'GET', url: '/auth/me' });
      await postJson(h, '/auth/logout', { refreshToken: tokens.refreshToken });
      const response = await h.app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: `Bearer ${METRICS_TOKEN}` },
      });
      assert.equal(response.statusCode, 200);
      const body = response.body;
      for (const expected of [
        /auth_logins_total\{kind="user",result="ok"\} 1/,
        /auth_logins_total\{kind="user",result="invalid"\} 1/,
        /auth_refresh_total\{result="ok"\} 1/,
        /auth_refresh_total\{result="reuse"\} 1/,
        /auth_token_rejections_total\{reason="missing"\} 1/,
      ]) {
        assert.match(body, expected);
      }
      const authLines = body.split('\n').filter((line) => line.startsWith('auth_'));
      assert.ok(authLines.length >= 5);
      for (const line of authLines) {
        assert.match(line, /^auth_[a-z_]+\{[a-z]+="[a-z]+"(,[a-z]+="[a-z]+")*\} \d+$/, line);
      }
      for (const secret of [email, client.id, client.slug, '192.0.2.77', tokens.accessToken]) {
        assert.ok(!body.includes(secret));
      }
      // "email" só vale como nome de label: a métrica account_password_reset_emails_total (021) o tem no nome.
      assert.doesNotMatch(body, /clientId|userId|\{[^}]*email|\bip=/i);
    });
  });
});
