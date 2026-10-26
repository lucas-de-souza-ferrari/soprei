import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { Database } from './database/index.js';
import type { RedisHandle } from './cache/redis.client.js';

export interface Infrastructure {
  readonly database: Database;
  readonly redis: RedisHandle;
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

/** Fecha o pool e o Redis; um não impede o outro de fechar. */
export async function closeInfrastructure(
  { database, redis }: Infrastructure,
  logger: FastifyBaseLogger,
): Promise<void> {
  const results = await Promise.allSettled([database.close(), redis.close()]);
  for (const result of results) {
    if (result.status === 'rejected') {
      logger.error({ err: result.reason }, 'falha ao fechar recurso de infraestrutura');
    }
  }
}

/** Ordem do shutdown: primeiro o Fastify (para de aceitar e termina requisições), depois o pool e o Redis. */
export async function shutdown(
  app: FastifyInstance,
  infrastructure: Infrastructure,
  logger: FastifyBaseLogger,
): Promise<void> {
  await app.close();
  await closeInfrastructure(infrastructure, logger);
}
