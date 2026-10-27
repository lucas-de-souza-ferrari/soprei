import Fastify, { type FastifyBaseLogger, type FastifyInstance, LogController } from 'fastify';
import type { AttendanceService } from '../../application/attendance.service.js';
import type { ClientService } from '../../application/client.service.js';
import { adminAttendanceController } from '../../presentation/admin/attendance.controller.js';
import { adminClientsController } from '../../presentation/admin/clients.controller.js';
import { healthController, type ReadinessChecks } from '../../presentation/health.controller.js';
import { metricsController } from '../../presentation/metrics.controller.js';
import type { Metrics } from '../metrics/index.js';
import { errorHandler, notFoundHandler } from './error-handler.js';
import { generateRequestId, registerObservability } from './observability.js';

export interface AdminRoutesParams {
  /** `ADMIN_API_KEY`. Ausente: as rotas existem, mas respondem sempre 401. */
  readonly apiKey: string | undefined;
  readonly clients: ClientService;
  /** Sem isto as rotas de mensagens e conversas (spec 010) não são registradas. */
  readonly attendance?: AttendanceService;
}

export interface BuildServerParams {
  readonly logger: FastifyBaseLogger;
  readonly readiness: ReadinessChecks;
  /** Sem isto as rotas /admin não são registradas (ex.: testes que não precisam delas). */
  readonly admin?: AdminRoutesParams;
  /** Métricas do processo. Sem isto não há métricas HTTP nem `GET /metrics`. */
  readonly metrics?: Metrics;
  /**
   * `METRICS_TOKEN`. `GET /metrics` só existe quando `metrics` e este token (já validado
   * na config, mínimo 32 caracteres) estão presentes; sem ele a rota responde 404.
   */
  readonly metricsToken?: string | undefined;
}

/** Monta o servidor sem escutar em porta, para que os testes usem `inject`. */
export function buildServer({
  logger,
  readiness,
  admin,
  metrics,
  metricsToken,
}: BuildServerParams): FastifyInstance {
  const app = Fastify({
    loggerInstance: logger,
    // `x-request-id` válido é reaproveitado; senão UUID. `requestIdHeader: false` deixa a
    // decisão toda para `genReqId`.
    genReqId: generateRequestId,
    requestIdHeader: false,
    // Log de requisição próprio (observability.ts): um log ao fim, com o padrão da rota, e o
    // id da requisição no campo `requestId`. O Fastify 5.12 deprecou `disableRequestLogging` e
    // `requestIdLogLabel` no topo das opções em favor do `LogController`.
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: 'requestId',
    }),
  });

  registerObservability(app, { metrics });
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  void app.register(healthController, { readiness });
  if (metrics !== undefined && metricsToken !== undefined && metricsToken !== '') {
    void app.register(metricsController, { token: metricsToken, source: metrics });
  }
  if (admin !== undefined) {
    void app.register(adminClientsController, {
      prefix: '/admin/clients',
      apiKey: admin.apiKey,
      clients: admin.clients,
    });
    if (admin.attendance !== undefined) {
      void app.register(adminAttendanceController, {
        prefix: '/admin/clients',
        apiKey: admin.apiKey,
        attendance: admin.attendance,
      });
    }
  }

  return app;
}
