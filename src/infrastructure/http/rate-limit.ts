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
import { observeStoreErrors } from '../cache/rate-limit-redis.js';
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
 * (o 429 entra no log de requisição e nas métricas HTTP) e ANTES de registrar as rotas (o plugin
 * liga o hook em cada rota que nasce depois dele).
 *
 * - `global: true`: toda rota é limitada; rota sem perfil cai em `public`;
 * - roda no `onRequest`, antes de ler o corpo e de autenticar;
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
    // Sem IP nem chave no log: o erro do Redis não os carrega e nada mais é anexado.
    app.log.error({ err }, 'rate limit: falha no Redis, requisição liberada (fail-open)');
    try {
      metrics?.countRateLimitStoreError();
    } catch (metricError) {
      app.log.warn({ err: metricError }, 'falha ao registrar métrica do rate limit');
    }
  });

  void app.register(rateLimit, {
    global: true,
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
}
