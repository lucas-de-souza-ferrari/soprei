import type { FastifyPluginCallback } from 'fastify';
import { bearerAuthHook } from '../common/bearer-auth.hook.js';
import { NO_RATE_LIMIT } from '../common/rate-limit.js';
import { routePattern } from '../common/route-pattern.js';

/** O que o endpoint precisa de quem guarda as métricas (a infraestrutura implementa). */
export interface MetricsSource {
  readonly contentType: string;
  render(): Promise<string>;
}

export interface MetricsControllerOptions {
  /** `METRICS_TOKEN`; sem ele o controller nem deve ser registrado (a rota não existe). */
  readonly token: string;
  readonly source: MetricsSource;
}

export const METRICS_ROUTE = '/metrics';

/** `GET /metrics` no formato de texto do Prometheus, atrás de Bearer em tempo constante. */
export const metricsController: FastifyPluginCallback<MetricsControllerOptions> = (
  app,
  { token, source },
  done,
) => {
  app.get(
    METRICS_ROUTE,
    {
      config: NO_RATE_LIMIT,
      onRequest: bearerAuthHook(token, (request) => {
        request.log.warn({ route: routePattern(request) }, 'acesso a /metrics recusado');
      }),
    },
    async (_request, reply) => {
      const body = await source.render();
      return reply.header('content-type', source.contentType).send(body);
    },
  );
  done();
};
