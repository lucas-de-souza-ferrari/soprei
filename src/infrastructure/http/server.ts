import Fastify, { type FastifyBaseLogger, type FastifyInstance, LogController } from 'fastify';
import type { AttendanceService } from '../../application/attendance/attendance.service.js';
import type { ChannelIntakeService } from '../../application/channel/channel-intake.service.js';
import type { ClientService } from '../../application/clients/client.service.js';
import { adminAttendanceController } from '../../presentation/admin/attendance.controller.js';
import { adminClientsController } from '../../presentation/admin/clients.controller.js';
import {
  healthController,
  type ReadinessChecks,
} from '../../presentation/system/health.controller.js';
import { metricsController } from '../../presentation/system/metrics.controller.js';
import { whatsappWebhookController } from '../../presentation/webhooks/whatsapp-webhook.controller.js';
import type { TrustProxySetting } from '../config/trust-proxy.js';
import type { Metrics } from '../metrics/index.js';
import { errorHandler, notFoundHandler } from './error-handler.js';
import { generateRequestId, registerObservability } from './observability/observability.js';
import { type RateLimitParams, registerRateLimit } from './rate-limit/rate-limit.js';

export interface AdminRoutesParams {
  /** `ADMIN_API_KEY`. Ausente: as rotas existem, mas respondem sempre 401. */
  readonly apiKey: string | undefined;
  readonly clients: ClientService;
  /** Sem isto as rotas de mensagens e conversas (spec 010) não são registradas. */
  readonly attendance?: AttendanceService;
}

/** Canal WhatsApp (spec 011): sem isto as rotas `/webhooks/whatsapp` NÃO existem (404). */
export interface WhatsappRoutesParams {
  /** `WHATSAPP_APP_SECRET`: só valida a assinatura. */
  readonly appSecret: string;
  /** `WHATSAPP_VERIFY_TOKEN`: só o handshake de verificação. */
  readonly verifyToken: string;
  readonly intake: Pick<ChannelIntakeService, 'accept'>;
}

export interface BuildServerParams {
  readonly logger: FastifyBaseLogger;
  readonly readiness: ReadinessChecks;
  /** Sem isto as rotas /admin não são registradas (ex.: testes que não precisam delas). */
  readonly admin?: AdminRoutesParams;
  /** Canal WhatsApp (spec 011). Opt-in: sem isto (`WHATSAPP_ENABLED=false`) as rotas não existem. */
  readonly whatsapp?: WhatsappRoutesParams;
  /** Métricas do processo. Sem isto não há métricas HTTP nem `GET /metrics`. */
  readonly metrics?: Metrics;
  /**
   * `METRICS_TOKEN`. `GET /metrics` só existe quando `metrics` e este token (já validado
   * na config, mínimo 32 caracteres) estão presentes; sem ele a rota responde 404.
   */
  readonly metricsToken?: string | undefined;
  /**
   * Rate limiting (spec 005). Sem isto o plugin NÃO é registrado e nada é limitado (testes que
   * não tratam de limite). Em produção o boot sempre passa (`RATE_LIMIT_ENABLED`).
   */
  readonly rateLimit?: RateLimitParams;
  /**
   * `TRUST_PROXY` (spec 005): de onde o Fastify tira `request.ip`. `false` (padrão) ignora
   * `X-Forwarded-For`; ver `trust-proxy.ts` para os demais valores.
   */
  readonly trustProxy?: TrustProxySetting;
}

/** O Fastify quer `string[]` mutável; a config entrega `readonly string[]`. */
function fastifyTrustProxy(setting: TrustProxySetting): boolean | string[] {
  return typeof setting === 'object' ? [...setting] : setting;
}

/** Monta o servidor sem escutar em porta, para que os testes usem `inject`. */
export function buildServer({
  logger,
  readiness,
  admin,
  whatsapp,
  metrics,
  metricsToken,
  rateLimit,
  trustProxy = false,
}: BuildServerParams): FastifyInstance {
  const app = Fastify({
    loggerInstance: logger,
    // `request.ip` (chave do rate limit) vem do socket, ou do X-Forwarded-For só se confiado.
    trustProxy: fastifyTrustProxy(trustProxy),
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
  // Depois da observabilidade (o 429 entra no log e nas métricas HTTP) e antes das rotas (o
  // plugin liga o hook em cada rota registrada depois dele).
  if (rateLimit !== undefined) registerRateLimit(app, rateLimit, metrics);
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

  if (whatsapp !== undefined) {
    void app.register(whatsappWebhookController, {
      appSecret: whatsapp.appSecret,
      verifyToken: whatsapp.verifyToken,
      intake: whatsapp.intake,
      ...(metrics === undefined ? {} : { metrics }),
    });
  }

  return app;
}
