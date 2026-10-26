import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { ClientService } from '../../application/client.service.js';
import { adminClientsController } from '../../presentation/admin/clients.controller.js';
import { healthController, type ReadinessChecks } from '../../presentation/health.controller.js';
import { errorHandler, notFoundHandler } from './error-handler.js';

export interface AdminRoutesParams {
  /** `ADMIN_API_KEY`. Ausente: as rotas existem, mas respondem sempre 401. */
  readonly apiKey: string | undefined;
  readonly clients: ClientService;
}

export interface BuildServerParams {
  readonly logger: FastifyBaseLogger;
  readonly readiness: ReadinessChecks;
  /** Sem isto as rotas /admin não são registradas (ex.: testes que não precisam delas). */
  readonly admin?: AdminRoutesParams;
}

/** Monta o servidor sem escutar em porta, para que os testes usem `inject`. */
export function buildServer({ logger, readiness, admin }: BuildServerParams): FastifyInstance {
  const app = Fastify({ loggerInstance: logger });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  void app.register(healthController, { readiness });
  if (admin !== undefined) {
    void app.register(adminClientsController, { prefix: '/admin/clients', ...admin });
  }

  return app;
}
