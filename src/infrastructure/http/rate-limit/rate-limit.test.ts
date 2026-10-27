import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Redis } from 'ioredis';
import { AttendanceService } from '../../../application/attendance/attendance.service.js';
import { ClientService } from '../../../application/clients/client.service.js';
import { Result } from '../../../shared/types/index.js';
import { isRateLimitProfile } from '../../../shared/rate-limit/profiles.js';
import { rateLimitProfile } from '../../../presentation/rate-limit.js';
import { captureLogs, type LogLine } from '../../../test-support/log-capture.js';
import { InMemoryAttendanceStore } from '../../../test-support/in-memory-attendance.js';
import { InMemoryClientRepository } from '../../../test-support/in-memory-client.repository.js';
import { createLogger } from '../../logger/logger.js';
import { createMetrics } from '../../metrics/index.js';
import { MockLlmProvider } from '../../external-apis/llm/mock-llm.provider.js';
import {
  type RateLimitProfiles,
  rateLimitProfilesFromConfig,
  registerRateLimit,
} from './rate-limit.js';
import { buildServer } from '../server.js';

const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });

const ALL_UP = {
  database: () => Promise.resolve(Result.ok(undefined)),
  redis: () => Promise.resolve(Result.ok(undefined)),
};

const PROFILES: RateLimitProfiles = {
  public: { max: 1, windowSeconds: 60 },
  admin: { max: 1, windowSeconds: 60 },
  webhook: { max: 1, windowSeconds: 60 },
};

describe('sem o parâmetro rateLimit', () => {
  it('buildServer não limita nada: muito acima de qualquer perfil, tudo responde 200', async () => {
    const app = buildServer({ logger, readiness: ALL_UP });
    void app.register((instance, _options, done) => {
      instance.get('/test/livre', () => ({ ok: true }));
      done();
    });
    await app.ready();
    try {
      for (let i = 0; i < 300; i += 1) {
        const response = await app.inject({ method: 'GET', url: '/test/livre' });
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers['x-ratelimit-limit'], undefined);
      }
    } finally {
      await app.close();
    }
  });
});

describe('inventário de rotas: toda rota declara o seu perfil', () => {
  it('toda rota tem perfil declarado; /admin é admin e só /health e /metrics ficam sem limite', async () => {
    const clients = new InMemoryClientRepository();
    const store = new InMemoryAttendanceStore();
    const metrics = createMetrics();
    const app = buildServer({
      logger,
      readiness: ALL_UP,
      metrics,
      metricsToken: 'm'.repeat(32),
      admin: {
        apiKey: randomUUID(),
        clients: new ClientService(clients),
        attendance: new AttendanceService({
          clients,
          conversations: store.conversations,
          messages: store.messages,
          unitOfWork: store,
          llm: new MockLlmProvider(),
          logger,
          options: { llmTimeoutMs: 1_000, inFlightTimeoutMs: 60_000 },
        }),
      },
    });
    const routes: { url: string; method: string | string[]; config: Record<string, unknown> }[] =
      [];
    app.addHook('onRoute', (route) => {
      routes.push({
        url: route.url,
        method: route.method,
        config: { ...(route.config as Record<string, unknown> | undefined) },
      });
    });
    await app.ready();
    await app.close();

    assert.ok(routes.length >= 9, `rotas vistas: ${String(routes.length)}`);
    const urls = new Set(routes.map((route) => route.url));
    for (const expected of ['/health', '/health/ready', '/metrics', '/admin/clients']) {
      assert.ok(
        [...urls].some((url) => url.startsWith(expected)),
        `rota ${expected} registrada`,
      );
    }

    // Regra do projeto: rota nova declara o perfil (cair em `public` por omissão é só a rede de
    // segurança). Só a infraestrutura fica sem limite, com opt-out explícito.
    const infrastructure = new Set(['/health', '/health/ready', '/metrics']);
    for (const route of routes) {
      const label = `${String(route.method)} ${route.url}`;
      // `config.rateLimit` só pode ser `false` (opt-out) ou ausente: o limite por rota (objeto) é
      // ignorado pelo hook da raiz, então declarar um daria falsa sensação de proteção.
      assert.ok(
        route.config.rateLimit === undefined || route.config.rateLimit === false,
        `${label} declara config.rateLimit como objeto (só false ou ausente; use rateLimitProfile)`,
      );
      if (infrastructure.has(route.url)) {
        assert.equal(route.config.rateLimit, false, `${label} deve ser opt-out explícito`);
      } else if (route.url.startsWith('/admin/')) {
        assert.equal(route.config.rateLimitProfile, 'admin', `${label} deve ser do perfil admin`);
      } else {
        assert.ok(
          isRateLimitProfile(route.config.rateLimitProfile),
          `${label} sem perfil declarado`,
        );
      }
    }
  });
});

describe('registerRateLimit', () => {
  it('recusa perfil com max ou janela inválidos (nunca registra limite sem sentido)', () => {
    const app = buildServer({ logger, readiness: ALL_UP });
    const redis = {} as Redis;
    for (const profiles of [
      { ...PROFILES, admin: { max: 0, windowSeconds: 60 } },
      { ...PROFILES, webhook: { max: 1, windowSeconds: 0 } },
      { ...PROFILES, public: { max: 1.5, windowSeconds: 60 } },
    ]) {
      assert.throws(() => {
        registerRateLimit(app, { redis, profiles });
      }, RangeError);
    }
  });

  it('rateLimitProfilesFromConfig lê os números de cada perfil da config', () => {
    assert.deepEqual(
      rateLimitProfilesFromConfig({
        RATE_LIMIT_PUBLIC_MAX: 1,
        RATE_LIMIT_PUBLIC_WINDOW_SECONDS: 2,
        RATE_LIMIT_ADMIN_MAX: 3,
        RATE_LIMIT_ADMIN_WINDOW_SECONDS: 4,
        RATE_LIMIT_WEBHOOK_MAX: 5,
        RATE_LIMIT_WEBHOOK_WINDOW_SECONDS: 6,
      }),
      {
        public: { max: 1, windowSeconds: 2 },
        admin: { max: 3, windowSeconds: 4 },
        webhook: { max: 5, windowSeconds: 6 },
      },
    );
  });
});

describe('falha ao registrar o plugin', () => {
  it('app.ready() rejeita: o servidor nunca sobe sem o limiter', async () => {
    const app = buildServer({
      logger,
      readiness: ALL_UP,
      rateLimit: {
        // O plugin chama `defineCommand` ao montar o store: aqui ele lança.
        redis: {
          defineCommand(): void {
            throw new Error('falha de teste no registro');
          },
        } as unknown as Redis,
        profiles: PROFILES,
      },
    });
    await assert.rejects(async () => {
      await app.ready();
    }, /falha de teste no registro/);
    await app.close().catch(() => undefined);
  });
});

describe('log do fail-open não vaza o IP', () => {
  const IP = '203.0.113.9';
  const PREFIX = 'soprei:ratelimit:';

  /** Client de mentira cujo script sempre falha com um erro no formato do ioredis (`command.args`). */
  function failingClient(makeError: () => Error): Redis {
    const client = {
      defineCommand(name: string): void {
        (client as unknown as Record<string, unknown>)[name] = (...args: unknown[]): void => {
          const callback = args.at(-1) as (error: Error) => void;
          const error = makeError();
          (error as Error & { command?: unknown }).command = {
            name: 'rateLimit',
            args: [`${PREFIX}webhook:${IP}`, 60_000],
          };
          callback(error);
        };
      },
    };
    return client as unknown as Redis;
  }

  async function requestWith(makeError: () => Error): Promise<{ raw: string; lines: LogLine[] }> {
    const logs = captureLogs();
    const app = buildServer({
      logger: logs.logger,
      readiness: ALL_UP,
      rateLimit: { redis: failingClient(makeError), profiles: PROFILES, keyPrefix: PREFIX },
    });
    void app.register((instance, _options, done) => {
      instance.get('/test/webhook', { config: rateLimitProfile('webhook') }, () => ({ ok: true }));
      done();
    });
    await app.ready();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/test/webhook',
        remoteAddress: IP,
      });
      assert.equal(response.statusCode, 200, 'fail-open');
    } finally {
      await app.close();
    }
    return { raw: logs.raw(), lines: logs.lines() };
  }

  it('erro com command.args (AbortError do ioredis): nem o IP nem o prefixo aparecem em log', async () => {
    const { raw, lines } = await requestWith(() => {
      const error = new Error('Command aborted due to connection close');
      error.name = 'AbortError';
      return error;
    });
    assert.ok(!raw.includes(IP), 'IP no log');
    assert.ok(!raw.includes(PREFIX), 'prefixo no log');
    assert.ok(!raw.includes('args'), 'command.args no log');
    const line = lines.find((entry) => String(entry.msg).includes('fail-open'));
    assert.ok(line);
    assert.equal(line.level, 50);
    assert.equal(line.errName, 'AbortError');
    assert.equal(line.errMessage, 'Command aborted due to connection close');
    assert.equal(line.err, undefined);
  });

  it('mensagem que cita a chave (ReplyError do servidor) não é logada; sobra o nome e o code', async () => {
    const { raw, lines } = await requestWith(() => {
      const error = new Error(`ERR falha em ${PREFIX}webhook:${IP}`);
      error.name = 'ReplyError';
      (error as Error & { code?: string }).code = 'ERR';
      return error;
    });
    assert.ok(!raw.includes(IP), 'IP no log');
    assert.ok(!raw.includes(PREFIX), 'prefixo no log');
    const line = lines.find((entry) => String(entry.msg).includes('fail-open'));
    assert.ok(line);
    assert.equal(line.errName, 'ReplyError');
    assert.equal(line.errCode, 'ERR');
    assert.equal(line.errMessage, undefined);
  });
});
