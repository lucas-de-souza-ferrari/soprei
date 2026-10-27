import type { FastifyPluginCallback } from 'fastify';
import type { Result } from '../shared/types/index.js';
import { NO_RATE_LIMIT } from './rate-limit.js';

export interface ReadinessChecks {
  readonly database: () => Promise<Result<void>>;
  readonly redis: () => Promise<Result<void>>;
}

export interface HealthControllerOptions {
  readonly readiness: ReadinessChecks;
}

type DependencyStatus = 'up' | 'down';

export const healthController: FastifyPluginCallback<HealthControllerOptions> = (
  app,
  { readiness },
  done,
) => {
  // Liveness: só indica que o processo responde. Não toca em dependências.
  app.get('/health', { config: NO_RATE_LIMIT }, () => ({ status: 'ok' }));

  // Readiness: banco e Redis. O corpo diz qual caiu, mas nunca o motivo (vai para o log).
  app.get('/health/ready', { config: NO_RATE_LIMIT }, async (request, reply) => {
    const [database, redis] = await Promise.all([readiness.database(), readiness.redis()]);
    const checks: Record<'database' | 'redis', DependencyStatus> = {
      database: database.ok ? 'up' : 'down',
      redis: redis.ok ? 'up' : 'down',
    };
    if (!database.ok) request.log.warn({ err: database.error }, 'readiness: banco indisponível');
    if (!redis.ok) request.log.warn({ err: redis.error }, 'readiness: Redis indisponível');

    const ready = database.ok && redis.ok;
    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ok' : 'unavailable', checks });
  });
  done();
};
