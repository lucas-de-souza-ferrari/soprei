import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import '../../presentation/rate-limit.js';
import { RateLimitError } from '../../shared/errors/index.js';
import {
  DEFAULT_RATE_LIMIT_PROFILE,
  isRateLimitProfile,
  RATE_LIMIT_PROFILES,
  type RateLimitProfile,
} from '../../shared/rate-limit/profiles.js';
import { describeRedisError, observeStoreErrors } from '../cache/rate-limit-redis.js';
import type { Config } from '../config/index.js';
import type { Metrics } from '../metrics/index.js';
import { clientIpOf } from './client-ip.js';

export interface RateLimitProfileLimits {
  /** Requisições permitidas por janela. */
  readonly max: number;
  readonly windowSeconds: number;
}

export type RateLimitProfiles = Readonly<Record<RateLimitProfile, RateLimitProfileLimits>>;

export type RateLimitProfileConfig = Pick<
  Config,
  | 'RATE_LIMIT_PUBLIC_MAX'
  | 'RATE_LIMIT_PUBLIC_WINDOW_SECONDS'
  | 'RATE_LIMIT_ADMIN_MAX'
  | 'RATE_LIMIT_ADMIN_WINDOW_SECONDS'
  | 'RATE_LIMIT_WEBHOOK_MAX'
  | 'RATE_LIMIT_WEBHOOK_WINDOW_SECONDS'
>;

/** Números de cada perfil, lidos da config (os perfis em si são só nomeados pelas rotas). */
export function rateLimitProfilesFromConfig(config: RateLimitProfileConfig): RateLimitProfiles {
  return {
    public: {
      max: config.RATE_LIMIT_PUBLIC_MAX,
      windowSeconds: config.RATE_LIMIT_PUBLIC_WINDOW_SECONDS,
    },
    admin: {
      max: config.RATE_LIMIT_ADMIN_MAX,
      windowSeconds: config.RATE_LIMIT_ADMIN_WINDOW_SECONDS,
    },
    webhook: {
      max: config.RATE_LIMIT_WEBHOOK_MAX,
      windowSeconds: config.RATE_LIMIT_WEBHOOK_WINDOW_SECONDS,
    },
  };
}

/** Prefixo das chaves no Redis. Os testes passam um prefixo único por teste. */
export const DEFAULT_RATE_LIMIT_KEY_PREFIX = 'soprei:ratelimit:';

export interface RateLimitParams {
  /** Conexão Redis dedicada ao limiter (`createRateLimitRedis(...).client`). */
  readonly redis: Redis;
  readonly profiles: RateLimitProfiles;
  /** Prefixo (namespace) das chaves; o resto da chave é `<perfil>:<ip normalizado>`. */
  readonly keyPrefix?: string;
}

/** Perfil da rota que atende a requisição; rota sem perfil (ou com valor inválido) é `public`. */
export function profileOf(request: FastifyRequest): RateLimitProfile {
  const declared: unknown = request.routeOptions.config.rateLimitProfile;
  return isRateLimitProfile(declared) ? declared : DEFAULT_RATE_LIMIT_PROFILE;
}

/**
 * Chave do contador: perfil + IP normalizado. Nunca `clientId` (antes da autenticação ele não
 * existe; a regra "chave deriva do ClientId" passa a valer na spec 007, com perfis
 * autenticados). O perfil na chave dá contadores independentes por perfil: esgotar `admin` não
 * consome `webhook` do mesmo IP, e um IP não consome a cota de outro.
 */
export function rateLimitKey(request: FastifyRequest): string {
  return `${profileOf(request)}:${clientIpOf(request)}`;
}

/**
 * Liga o `@fastify/rate-limit` à instância (spec 005). Chame DEPOIS de `registerObservability`
 * (o 429 entra no log de requisição e nas métricas HTTP; o contexto já existe) e ANTES de
 * registrar as rotas.
 *
 * - **Hook `onRequest` da instância raiz**, não o hook por rota do plugin (`global: true`): o
 *   hook da raiz roda antes de qualquer hook de plugin filho, como o de autenticação de
 *   `/admin` (`app.addHook('onRequest', adminAuthHook(...))` no controller). Com o hook por rota
 *   o limite rodaria DEPOIS da autenticação e tentativa de adivinhar a `ADMIN_API_KEY` recebia
 *   401 sem nunca esbarrar no 429 (o teste de integração pegou isso). Vale também para a 011
 *   (assinatura do webhook) e a 007 (JWT): o limiter é sempre o primeiro, antes de ler corpo;
 * - toda rota é limitada: sem perfil cai em `public`; opt-out só com `config: { rateLimit: false }`
 *   (`/health`, `/health/ready`, `/metrics`) e o 404 de rota inexistente não conta;
 * - store Redis (script atômico do plugin: INCR + PEXPIRE, sempre com TTL);
 * - `skipOnError: true`: Redis fora é fail-open, com log `error` e `rate_limit_store_errors_total`.
 */
export function registerRateLimit(
  app: FastifyInstance,
  { redis, profiles, keyPrefix = DEFAULT_RATE_LIMIT_KEY_PREFIX }: RateLimitParams,
  metrics?: Metrics,
): void {
  for (const profile of RATE_LIMIT_PROFILES) {
    const limits = profiles[profile];
    if (!Number.isInteger(limits.max) || limits.max < 1) {
      throw new RangeError(`rate limit: max inválido no perfil ${profile}`);
    }
    if (!Number.isInteger(limits.windowSeconds) || limits.windowSeconds < 1) {
      throw new RangeError(`rate limit: janela inválida no perfil ${profile}`);
    }
  }

  const store = observeStoreErrors(redis, (err) => {
    // Nunca `{ err }`: o ioredis anexa `command.args` (a chave, com o IP) ao erro e o Pino o copiaria.
    app.log.error(
      describeRedisError(err),
      'rate limit: falha no Redis, requisição liberada (fail-open)',
    );
    try {
      metrics?.countRateLimitStoreError();
    } catch (metricError) {
      app.log.warn({ err: metricError }, 'falha ao registrar métrica do rate limit');
    }
  });

  void app.register(rateLimit, {
    // O hook é nosso (abaixo); o plugin só fornece `app.rateLimit()` com estes parâmetros.
    global: false,
    redis: store,
    nameSpace: keyPrefix,
    skipOnError: true,
    keyGenerator: rateLimitKey,
    max: (request) => profiles[profileOf(request)].max,
    timeWindow: (request) => profiles[profileOf(request)].windowSeconds * 1_000,
    // Só os cabeçalhos X-RateLimit-* e Retry-After (sem a variante `draft`).
    enableDraftSpec: false,
    errorResponseBuilder: (_request, context) => new RateLimitError(Math.ceil(context.ttl / 1_000)),
    onExceeded: (request) => {
      try {
        metrics?.countRateLimitRejected(profileOf(request));
      } catch (err) {
        request.log.warn({ err }, 'falha ao registrar métrica do rate limit');
      }
    },
  });

  // `after`: roda quando o plugin acima já carregou (`app.rateLimit` existe) e antes dos plugins
  // registrados depois (controllers), que herdam este hook.
  app.after((error) => {
    if (error !== null) return;
    const limit = app.rateLimit();
    app.addHook('onRequest', async function rateLimitHook(request, reply) {
      // 404 não tem perfil (e o plugin também não o cobriria); `rateLimit: false` é o opt-out.
      if (request.is404 || request.routeOptions.config.rateLimit === false) return;
      await limit.call(app, request, reply);
    });
  });
}
