import type { FastifyBaseLogger } from 'fastify';
import { Redis } from 'ioredis';
import { ExternalServiceError } from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import { withTimeout } from '../../shared/utils/index.js';
import { type Config, loadConfig } from '../config/index.js';
import { createLogger } from '../logger/logger.js';

export type RedisConfig = Pick<Config, 'REDIS_URL'>;

export interface RedisHandle {
  readonly client: Redis;
  /** Verifica o Redis com `PING`. Nunca lança: a falha volta como `ExternalServiceError`. */
  check(timeoutMs?: number): Promise<Result<void, ExternalServiceError>>;
  /** Encerra a conexão e cancela a reconexão. Idempotente. */
  close(): Promise<void>;
}

const DEFAULT_CHECK_TIMEOUT_MS = 2_000;
const CONNECT_TIMEOUT_MS = 5_000;
const CLOSE_TIMEOUT_MS = 2_000;

/** Cria um client `ioredis`. Prefira `getRedis()`. */
export function createRedis(config: RedisConfig, logger: FastifyBaseLogger): RedisHandle {
  const client = new Redis(config.REDIS_URL, {
    connectTimeout: CONNECT_TIMEOUT_MS,
    // Comando enfileirado falha depois de poucas tentativas em vez de esperar para sempre.
    maxRetriesPerRequest: 2,
    // Reconecta sempre, com espera crescente de no máximo 2 s.
    retryStrategy: (times) => Math.min(times * 200, 2_000),
  });
  // Sem listener de erro o ioredis só imprime no console; aqui vira log estruturado.
  client.on('error', (err: Error) => {
    logger.error({ err }, 'erro no client Redis');
  });

  let closing: Promise<void> | undefined;

  return {
    client,
    async check(timeoutMs = DEFAULT_CHECK_TIMEOUT_MS) {
      try {
        await withTimeout(client.ping(), timeoutMs, 'redis');
        return Result.ok(undefined);
      } catch (error) {
        return Result.err(
          new ExternalServiceError('Redis indisponível', {
            cause: error,
            context: { service: 'redis' },
          }),
        );
      }
    },
    close() {
      closing ??= closeClient(client);
      return closing;
    },
  };
}

async function closeClient(client: Redis): Promise<void> {
  if (client.status === 'end') return;
  if (client.status !== 'ready') {
    // Sem conexão ativa não há o que negociar: só cancela as tentativas de reconexão.
    client.disconnect();
    return;
  }
  // `quit()` resolve ao receber o OK; o socket só fecha de fato no evento `end`.
  const ended = new Promise<void>((resolve) => {
    client.once('end', resolve);
  });
  try {
    await client.quit();
    await withTimeout(ended, CLOSE_TIMEOUT_MS, 'fechamento do Redis');
  } catch {
    client.disconnect();
  }
}

export interface GetRedisOptions {
  readonly config: RedisConfig;
  readonly logger: FastifyBaseLogger;
}

let instance: RedisHandle | undefined;

/** Único client Redis do processo: a primeira chamada o cria, as demais o reutilizam. */
export function getRedis(options?: GetRedisOptions): RedisHandle {
  if (instance === undefined) {
    const resolved = options ?? defaultOptions();
    instance = createRedis(resolved.config, resolved.logger);
  }
  return instance;
}

/** Fecha o singleton e libera o slot, para o shutdown e para os testes. */
export async function closeRedis(): Promise<void> {
  const current = instance;
  instance = undefined;
  await current?.close();
}

function defaultOptions(): GetRedisOptions {
  const config: Config = loadConfig();
  return { config, logger: createLogger(config) };
}
