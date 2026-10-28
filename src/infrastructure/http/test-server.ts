import type { FastifyInstance } from 'fastify';
import type { ReadinessChecks } from '../../presentation/system/health.controller.js';
import { Result } from '../../shared/types/index.js';
import { createLogger } from '../logger/logger.js';
import { type AdminRoutesParams, type BuildServerParams, buildServer } from './server.js';

const ALL_UP: ReadinessChecks = {
  database: () => Promise.resolve(Result.ok(undefined)),
  redis: () => Promise.resolve(Result.ok(undefined)),
};

/** Servidor com log silencioso para os testes; por padrão banco e Redis "no ar". */
export function buildTestServer(
  readiness: ReadinessChecks = ALL_UP,
  admin?: AdminRoutesParams,
  extra: Pick<BuildServerParams, 'metrics' | 'metricsToken' | 'whatsapp'> = {},
): FastifyInstance {
  return buildServer({
    logger: createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
    readiness,
    ...(admin === undefined ? {} : { admin }),
    ...extra,
  });
}
