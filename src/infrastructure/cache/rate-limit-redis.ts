import { AsyncResource } from 'node:async_hooks';
import type { FastifyBaseLogger } from 'fastify';
import { Redis } from 'ioredis';
import type { Config } from '../config/index.js';
import { closeRedisClient } from './redis.client.js';

export type RateLimitRedisConfig = Pick<Config, 'REDIS_URL' | 'RATE_LIMIT_REDIS_TIMEOUT_MS'>;

export interface RateLimitRedisHandle {
  readonly client: Redis;
  /**
   * Espera a conexão ficar pronta, por no máximo `timeoutMs`. Nunca lança: `false` significa
   * que não ficou (o limiter segue em fail-open e a conexão continua tentando).
   */
  waitUntilReady(timeoutMs: number): Promise<boolean>;
  /** Encerra a conexão e cancela a reconexão. Idempotente. */
  close(): Promise<void>;
}

const CONNECT_TIMEOUT_MS = 2_000;

/**
 * Conexão Redis DEDICADA ao limiter (spec 005), separada do singleton do resto do sistema.
 * O singleton enfileira comandos enquanto reconecta, o que seguraria cada requisição com o
 * Redis fora. Aqui a fila offline é desligada (comando sem conexão falha na hora) e cada
 * comando tem um prazo curto (`RATE_LIMIT_REDIS_TIMEOUT_MS`): Redis fora ou lento custa no
 * máximo esse prazo por requisição, e o limiter segue em fail-open.
 */
export function createRateLimitRedis(
  config: RateLimitRedisConfig,
  logger: FastifyBaseLogger,
): RateLimitRedisHandle {
  const client = new Redis(config.REDIS_URL, {
    connectTimeout: CONNECT_TIMEOUT_MS,
    enableOfflineQueue: false,
    commandTimeout: config.RATE_LIMIT_REDIS_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    // Mesma estratégia de reconexão do singleton: sempre, com espera de no máximo 2 s.
    retryStrategy: (times) => Math.min(times * 200, 2_000),
  });
  client.on('error', (err: Error) => {
    logger.error({ err }, 'erro na conexão Redis do rate limit');
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

type ScriptCallback = (error: Error | null, result?: unknown) => void;
type ScriptCommand = (...args: unknown[]) => unknown;

interface ScriptDefinition {
  readonly numberOfKeys: number;
  readonly lua: string;
}

/**
 * O que o `RedisStore` do `@fastify/rate-limit` usa do client: `defineCommand` (uma vez) e os
 * comandos `rateLimit` e `rateLimitRead`, chamados com callback no fim.
 */
export interface RateLimitRedisFacade {
  defineCommand(name: string, definition: ScriptDefinition): void;
  rateLimit?: ScriptCommand;
  rateLimitRead?: ScriptCommand;
}

/**
 * Casca fina sobre o client Redis para o plugin: repassa tudo igual, mas avisa `onError` de
 * toda falha de comando. Existe porque `skipOnError: true` faz o plugin engolir a falha do
 * store em silêncio (a requisição passa, sem sinal algum); sem isto não haveria o log `error`
 * nem a métrica `rate_limit_store_errors_total` que a spec 005 exige. Não altera resultado,
 * nem a chave, nem o script Lua do plugin (INCR + PEXPIRE atômicos).
 *
 * O callback do plugin roda dentro do contexto assíncrono de quem chamou (a requisição), para
 * o log da falha herdar `requestId` pelo `mixin` do logger.
 */
export function observeStoreErrors(
  client: Redis,
  onError: (error: Error) => void,
): RateLimitRedisFacade {
  const facade: RateLimitRedisFacade = {
    defineCommand(name, definition) {
      client.defineCommand(name, definition);
      const command = (client as unknown as Record<string, ScriptCommand>)[name];
      if (command === undefined) return;
      const observed: ScriptCommand = (...args) => {
        const callback = args.pop();
        if (typeof callback !== 'function') return command.apply(client, args);
        const plugin = callback as ScriptCallback;
        const settle: ScriptCallback = AsyncResource.bind((error, result) => {
          if (error !== null) onError(error);
          plugin(error, result);
        });
        try {
          return command.apply(client, [...args, settle]);
        } catch (error) {
          settle(error instanceof Error ? error : new Error(String(error)));
          return undefined;
        }
      };
      (facade as unknown as Record<string, ScriptCommand>)[name] = observed;
    },
  };
  return facade;
}
