import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { Database } from './database/index.js';
import type { RateLimitRedisHandle } from './cache/rate-limit-redis.js';
import type { RedisHandle } from './cache/redis.client.js';
import type { InboundQueueHandle } from './queue/inbound-queue.js';

export interface Infrastructure {
  readonly database: Database;
  readonly redis: RedisHandle;
  /** Conexão Redis dedicada ao rate limit (spec 005); ausente com `RATE_LIMIT_ENABLED=false`. */
  readonly rateLimitRedis?: RateLimitRedisHandle | undefined;
  /** Fila de entrada do canal e seu worker (spec 011); ausente com `WHATSAPP_ENABLED=false`. */
  readonly inboundQueue?: Pick<InboundQueueHandle, 'close'> | undefined;
}

/**
 * Verifica banco e Redis. Devolve a lista de dependências indisponíveis (vazia = tudo
 * certo) e registra no log o motivo de cada falha.
 */
export async function verifyInfrastructure(
  { database, redis }: Infrastructure,
  logger: FastifyBaseLogger,
): Promise<readonly string[]> {
  const [databaseResult, redisResult] = await Promise.all([
    database.check(5_000),
    redis.check(5_000),
  ]);
  const failed: string[] = [];
  if (!databaseResult.ok) {
    failed.push('PostgreSQL');
    logger.error({ err: databaseResult.error }, 'PostgreSQL indisponível');
  }
  if (!redisResult.ok) {
    failed.push('Redis');
    logger.error({ err: redisResult.error }, 'Redis indisponível');
  }
  return failed;
}

/**
 * Fecha a fila (o worker espera o job ativo terminar) e **só depois** o pool e os Redis: o job
 * ativo ainda usa o banco e o Redis. Um recurso que falha ao fechar não impede os outros.
 */
export async function closeInfrastructure(
  { database, redis, rateLimitRedis, inboundQueue }: Infrastructure,
  logger: FastifyBaseLogger,
): Promise<void> {
  if (inboundQueue !== undefined) {
    try {
      await inboundQueue.close();
    } catch (err) {
      logger.error(
        { errName: err instanceof Error ? err.name : typeof err },
        'falha ao encerrar a fila de entrada',
      );
    }
  }
  const results = await Promise.allSettled([
    database.close(),
    redis.close(),
    rateLimitRedis?.close(),
  ]);
  for (const result of results) {
    if (result.status === 'rejected') {
      logger.error({ err: result.reason }, 'falha ao fechar recurso de infraestrutura');
    }
  }
}

/**
 * Ordem do shutdown: o Fastify (para de aceitar e termina requisições), a fila e o worker (esperam o
 * job ativo) e, por último, o pool e o Redis.
 */
export async function shutdown(
  app: FastifyInstance,
  infrastructure: Infrastructure,
  logger: FastifyBaseLogger,
): Promise<void> {
  await app.close();
  await closeInfrastructure(infrastructure, logger);
}
