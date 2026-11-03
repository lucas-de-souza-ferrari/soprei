import Fastify, { type FastifyBaseLogger, type FastifyInstance, LogController } from 'fastify';
import type { AccountService } from '../../application/auth/account.service.js';
import { accountController, accountCookie } from '../../presentation/auth/account.controller.js';
import { ForbiddenError } from '../../shared/errors/index.js';
import type { AuthService } from '../../application/auth/auth.service.js';
import type { AttendanceService } from '../../application/attendance/attendance.service.js';
import type { ChannelIntakeService } from '../../application/channel/channel-intake.service.js';
import type { ChannelConnectionService } from '../../application/channel/channel-connection.service.js';
import type { ClientService } from '../../application/clients/client.service.js';
import type { UserAdminService } from '../../application/users/user-admin.service.js';
import { authController } from '../../presentation/auth/auth.controller.js';
import { adminAttendanceController } from '../../presentation/admin/attendance.controller.js';
import { adminAuditController } from '../../presentation/admin/audit.controller.js';
import { adminChannelController } from '../../presentation/admin/channel.controller.js';
import { adminClientsController } from '../../presentation/admin/clients.controller.js';
import { adminUsersController } from '../../presentation/admin/users.controller.js';
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
  readonly clients: ClientService;
  /** Sem isto as rotas de mensagens e conversas (spec 010) não são registradas. */
  readonly attendance?: AttendanceService;
  /**
   * Conexão do canal WhatsApp do cliente (spec 015): `GET`, `PUT` e `DELETE` em
   * `/admin/clients/:clientId/channel`. Só existe com `WHATSAPP_ENABLED=true` (sem isto, 404).
   */
  readonly channel?: Pick<
    ChannelConnectionService,
    'getState' | 'connect' | 'disconnect' | 'embeddedSignup'
  >;
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
  readonly accounts?: { service: AccountService; origin: string; secure: boolean };
  readonly logger: FastifyBaseLogger;
  readonly readiness: ReadinessChecks;
  /**
   * Autenticação (spec 007): registra `/auth/*` e verifica os access tokens das rotas `/admin`.
   * Obrigatória quando `admin` é passado (rota protegida sem autenticação nunca sobe).
   */
  readonly auth?: AuthService;
  /**
   * Gestão de usuários do cliente, auditoria e troca da própria senha (spec 008): registra
   * `POST /auth/password` e, com `admin`, as rotas `/admin/clients/:clientId/users` e
   * `.../audit-events`. Exige `auth`. Sem isto essas rotas não existem.
   */
  readonly userAdmin?: UserAdminService;
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
  auth,
  userAdmin,
  admin,
  whatsapp,
  metrics,
  metricsToken,
  rateLimit,
  trustProxy = false,
  accounts,
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

  // Preenchido pelo hook `authenticate` (spec 007); `null` nas rotas públicas.
  app.decorateRequest('auth', null);

  registerObservability(app, { metrics });
  // Depois da observabilidade (o 429 entra no log e nas métricas HTTP) e antes das rotas (o
  // plugin liga o hook em cada rota registrada depois dele).
  if (rateLimit !== undefined) registerRateLimit(app, rateLimit, metrics);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  if (accounts !== undefined) {
    app.addHook('onRequest', async (request, reply) => {
      const path = request.routeOptions.url ?? '';
      if (path.startsWith('/admin/') || path === '/auth/me')
        void reply.header('cache-control', 'no-store');
      if (
        (path.endsWith('/users') && request.method === 'POST') ||
        path.endsWith('/users/:userId/password') ||
        path === '/auth/password'
      ) {
        throw new ForbiddenError('Gestão de senha e criação de conta são globais');
      }
      if (
        request.headers.authorization === undefined &&
        request.headers.cookie !== undefined &&
        (path.startsWith('/admin/') || path === '/auth/me')
      ) {
        request.auth = await accounts.service.tenantIdentity(accountCookie(request.headers.cookie));
      }
      if (
        request.auth !== null &&
        !['GET', 'HEAD'].includes(request.method) &&
        (request.headers.origin !== accounts.origin || request.headers['x-soprei-client'] !== 'web')
      ) {
        throw new ForbiddenError('Origem inválida');
      }
    });
    void app.register(accountController, {
      ...accounts,
      ...(auth === undefined ? {} : { legacyAuth: auth }),
    });
  }

  void app.register(healthController, { readiness });
  if (metrics !== undefined && metricsToken !== undefined && metricsToken !== '') {
    void app.register(metricsController, { token: metricsToken, source: metrics });
  }
  if (auth !== undefined) {
    void app.register(authController, {
      prefix: '/auth',
      auth,
      metrics,
      browserAccounts: accounts !== undefined,
      ...(userAdmin === undefined ? {} : { userAdmin }),
    });
  }
  if (admin !== undefined) {
    // Rota /admin sem verificação de token nunca sobe: falha o boot, não vira rota aberta.
    if (auth === undefined) {
      throw new Error('as rotas /admin exigem o serviço de autenticação (auth)');
    }
    void app.register(adminClientsController, {
      prefix: '/admin/clients',
      auth,
      metrics,
      clients: admin.clients,
    });
    if (userAdmin !== undefined) {
      void app.register(adminUsersController, {
        prefix: '/admin/clients',
        auth,
        metrics,
        users: userAdmin,
      });
      void app.register(adminAuditController, {
        prefix: '/admin/clients',
        auth,
        metrics,
        users: userAdmin,
      });
    }
    if (admin.channel !== undefined) {
      void app.register(adminChannelController, {
        prefix: '/admin/clients',
        auth,
        metrics,
        channel: admin.channel,
      });
    }
    if (admin.attendance !== undefined) {
      void app.register(adminAttendanceController, {
        prefix: '/admin/clients',
        auth,
        metrics,
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
