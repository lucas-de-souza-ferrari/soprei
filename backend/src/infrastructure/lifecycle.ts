import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { Database } from './database/index.js';
import type { AuthRedisHandle } from './auth/auth-redis.js';
import type { RateLimitRedisHandle } from './cache/rate-limit-redis.js';
import type { RedisHandle } from './cache/redis.client.js';
import type { InboundQueueHandle } from './queue/inbound-queue.js';

export interface Infrastructure {
  readonly database: Database;
  readonly redis: RedisHandle;
  /** Conexão Redis dedicada ao rate limit (spec 005); ausente com `RATE_LIMIT_ENABLED=false`. */
  readonly rateLimitRedis?: RateLimitRedisHandle | undefined;
  /** Conexão Redis dedicada às sessões (spec 007); opcional só nos testes de ciclo de vida. */
  readonly authRedis?: AuthRedisHandle | undefined;
  /** Fila de entrada do canal e seu worker (spec 011); ausente com `WHATSAPP_ENABLED=false`. */
  readonly inboundQueue?: Pick<InboundQueueHandle, 'close'> | undefined;
  /** Timer do expurgo de contas não confirmadas (spec 021); ausente sem contas ou com intervalo 0. */
  accountPurge?: { stop(): Promise<void> } | undefined;
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
  { database, redis, rateLimitRedis, authRedis, inboundQueue, accountPurge }: Infrastructure,
  logger: FastifyBaseLogger,
): Promise<void> {
  // O expurgo usa o banco: para o timer e espera a execução ativa antes de fechar o pool.
  if (accountPurge !== undefined) {
    try {
      await accountPurge.stop();
    } catch {
      logger.error('falha ao encerrar o expurgo de contas');
    }
  }
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
    authRedis?.close(),
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
