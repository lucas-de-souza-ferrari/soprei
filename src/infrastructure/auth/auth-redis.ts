import type { FastifyBaseLogger } from 'fastify';
import { Redis } from 'ioredis';
import { describeRedisError } from '../cache/rate-limit-redis.js';
import { closeRedisClient } from '../cache/redis.client.js';
import type { Config } from '../config/index.js';

export type AuthRedisConfig = Pick<Config, 'REDIS_URL' | 'AUTH_REDIS_TIMEOUT_MS'>;

export interface AuthRedisHandle {
  readonly client: Redis;
  /** Espera a conexão ficar pronta por no máximo `timeoutMs`. Nunca lança. */
  waitUntilReady(timeoutMs: number): Promise<boolean>;
  /** Encerra a conexão e cancela a reconexão. Idempotente. */
  close(): Promise<void>;
}

const CONNECT_TIMEOUT_MS = 2_000;

/**
 * Conexão Redis DEDICADA às sessões (spec 007), no molde do `createRateLimitRedis`: fila offline
 * desligada (comando sem conexão falha na hora) e prazo curto por comando (`AUTH_REDIS_TIMEOUT_MS`).
 * Redis fora ou lento custa no máximo esse prazo por requisição e a autenticação responde 503
 * (fail-closed), nunca aceita nem emite nada.
 */
export function createAuthRedis(
  config: AuthRedisConfig,
  logger: FastifyBaseLogger,
): AuthRedisHandle {
  const client = new Redis(config.REDIS_URL, {
    connectTimeout: CONNECT_TIMEOUT_MS,
    enableOfflineQueue: false,
    commandTimeout: config.AUTH_REDIS_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => Math.min(times * 200, 2_000),
  });
  client.on('error', (err: Error) => {
    // Só campos controlados: o erro inteiro pode carregar `command.args` (chaves e ids).
    logger.error(describeRedisError(err), 'erro na conexão Redis de autenticação');
  });

  let closing: Promise<void> | undefined;

  return {
    client,
    async waitUntilReady(timeoutMs) {
      if (client.status === 'ready') return true;
      return new Promise<boolean>((resolve) => {
        const finish = (ready: boolean): void => {
          clearTimeout(timer);
          client.off('ready', onReady);
          resolve(ready);
        };
        const onReady = (): void => {
          finish(true);
        };
        const timer = setTimeout(() => {
          finish(false);
        }, timeoutMs);
        client.once('ready', onReady);
      });
    },
    close() {
      closing ??= closeRedisClient(client);
      return closing;
    },
  };
}
