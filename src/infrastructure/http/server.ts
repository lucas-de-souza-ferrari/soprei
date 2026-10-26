import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { healthController } from '../../presentation/health.controller.js';
import { errorHandler, notFoundHandler } from './error-handler.js';

export interface BuildServerParams {
  readonly logger: FastifyBaseLogger;
}

/** Monta o servidor sem escutar em porta, para que os testes usem `inject`. */
export function buildServer({ logger }: BuildServerParams): FastifyInstance {
  const app = Fastify({ loggerInstance: logger });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  void app.register(healthController);

  return app;
}
