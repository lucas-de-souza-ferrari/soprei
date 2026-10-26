import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { healthController, type ReadinessChecks } from '../../presentation/health.controller.js';
import { errorHandler, notFoundHandler } from './error-handler.js';

export interface BuildServerParams {
  readonly logger: FastifyBaseLogger;
  readonly readiness: ReadinessChecks;
}

/** Monta o servidor sem escutar em porta, para que os testes usem `inject`. */
export function buildServer({ logger, readiness }: BuildServerParams): FastifyInstance {
  const app = Fastify({ loggerInstance: logger });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  void app.register(healthController, { readiness });

  return app;
}
