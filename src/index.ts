import { AttendanceService } from './application/attendance/attendance.service.js';
import { ChannelInboundProcessor } from './application/channel/channel-inbound.processor.js';
import { ChannelIntakeService } from './application/channel/channel-intake.service.js';
import { ClientService } from './application/clients/client.service.js';
import { createRateLimitRedis } from './infrastructure/cache/rate-limit-redis.js';
import { getRedis } from './infrastructure/cache/redis.client.js';
import {
  loadConfig,
  queueSettings,
  trustProxyMode,
  whatsappChannelConfig,
} from './infrastructure/config/index.js';
import {
  getDatabase,
  PrismaAttendanceUnitOfWork,
  PrismaClientRepository,
  PrismaConversationRepository,
  PrismaMessageRepository,
} from './infrastructure/database/index.js';
import { createLlmProvider } from './infrastructure/external-apis/llm/create-llm-provider.js';
import { WhatsappCloudApiClient } from './infrastructure/external-apis/whatsapp/whatsapp-cloud-api.client.js';
import { rateLimitProfilesFromConfig } from './infrastructure/http/rate-limit/rate-limit.js';
import { buildServer, type WhatsappRoutesParams } from './infrastructure/http/server.js';
import {
  closeInfrastructure,
  type Infrastructure,
  shutdown,
  verifyInfrastructure,
} from './infrastructure/lifecycle.js';
import { createLogger } from './infrastructure/logger/logger.js';
import { createMetrics } from './infrastructure/metrics/index.js';
import { createInboundQueue } from './infrastructure/queue/inbound-queue.js';

/** Espera da conexão Redis do rate limit no boot; passou disso, segue em fail-open com `warn`. */
const RATE_LIMIT_READY_TIMEOUT_MS = 2_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  const metrics = createMetrics();
  const whatsapp = whatsappChannelConfig(config);
  // Fila de entrada do canal (spec 011), com conexões Redis próprias; só com o canal habilitado.
  const inboundQueue =
    whatsapp === undefined
      ? undefined
      : createInboundQueue({
          redisUrl: config.REDIS_URL,
          settings: queueSettings(config),
          logger,
          metrics,
        });

  const infrastructure: Infrastructure = {
    database: getDatabase({
      config,
      logger,
      queryObserver: (sample) => {
        metrics.observeDbQuery(sample);
      },
    }),
    redis: getRedis({ config, logger }),
    // Conexão própria do limiter (spec 005), com fila offline desligada e prazo curto por comando.
    rateLimitRedis: config.RATE_LIMIT_ENABLED ? createRateLimitRedis(config, logger) : undefined,
    inboundQueue,
  };

  metrics.bindPool(() => infrastructure.database.poolMetrics());

  // Fail-fast: auth e rate limit dependem do Redis e tudo depende do banco; subir "meio
  // vivo" esconde o problema. Em runtime, a degradação é decidida por spec.
  const unavailable = await verifyInfrastructure(infrastructure, logger);
  if (unavailable.length > 0) {
    logger.fatal({ unavailable }, `dependência indisponível no boot: ${unavailable.join(', ')}`);
    await closeInfrastructure(infrastructure, logger);
    process.exit(1);
  }

  const { rateLimitRedis } = infrastructure;
  if (rateLimitRedis === undefined) {
    logger.warn('rate limiting desligado (RATE_LIMIT_ENABLED=false)');
  } else if (!(await rateLimitRedis.waitUntilReady(RATE_LIMIT_READY_TIMEOUT_MS))) {
    // O Redis principal respondeu há instantes, então isto é raro; o limiter fica em fail-open
    // (com log e métrica por requisição) até a conexão dedicada subir.
    logger.warn('conexão Redis do rate limit ainda não está pronta; seguindo em fail-open');
  }
  if (config.TRUST_PROXY === true) {
    logger.warn(
      'TRUST_PROXY=true confia em toda a cadeia X-Forwarded-For (o cliente escolhe o IP); use só em ambiente fechado',
    );
  }

  const { prisma } = infrastructure.database;
  const clientRepository = new PrismaClientRepository(prisma);
  const attendance = new AttendanceService({
    clients: clientRepository,
    conversations: new PrismaConversationRepository(prisma),
    messages: new PrismaMessageRepository(prisma),
    unitOfWork: new PrismaAttendanceUnitOfWork(prisma),
    llm: createLlmProvider(config),
    logger,
    metrics,
    options: {
      llmTimeoutMs: config.LLM_TIMEOUT_MS,
      inFlightTimeoutMs: config.ATTENDANCE_IN_FLIGHT_TIMEOUT_MS,
    },
  });

  let whatsappRoutes: WhatsappRoutesParams | undefined;
  if (whatsapp !== undefined && inboundQueue !== undefined) {
    const channelLogger = logger;
    const processor = new ChannelInboundProcessor({
      attendance,
      clients: clientRepository,
      messages: new PrismaMessageRepository(prisma),
      sender: new WhatsappCloudApiClient({
        baseUrl: whatsapp.apiBaseUrl,
        graphApiVersion: whatsapp.graphApiVersion,
        accessToken: whatsapp.accessToken,
        timeoutMs: whatsapp.sendTimeoutMs,
        metrics,
      }),
      logger: channelLogger,
    });
    // Worker no mesmo processo, concorrência 1; o shutdown o espera antes de fechar Redis e banco.
    inboundQueue.startWorker((job, context) => processor.process(job, context), {
      onUnhandledFailure: (job) => processor.handleUnprocessedFailure(job),
    });
    whatsappRoutes = {
      appSecret: whatsapp.appSecret,
      verifyToken: whatsapp.verifyToken,
      intake: new ChannelIntakeService({
        clients: clientRepository,
        queue: inboundQueue.queue,
        logger: channelLogger,
        metrics,
        channel: 'whatsapp',
      }),
    };
    // Qual modo do TRUST_PROXY está ativo, sem IP algum (a Meta e um atacante dividiriam a cota
    // do perfil webhook se o túnel/proxy não estivesse listado).
    logger.info(
      {
        trustProxyMode: trustProxyMode(config.TRUST_PROXY),
        graphApiVersion: whatsapp.graphApiVersion,
      },
      'canal WhatsApp habilitado',
    );
  }

  const app = buildServer({
    logger,
    metrics,
    metricsToken: config.METRICS_TOKEN,
    trustProxy: config.TRUST_PROXY,
    ...(rateLimitRedis === undefined
      ? {}
      : {
          rateLimit: {
            redis: rateLimitRedis.client,
            profiles: rateLimitProfilesFromConfig(config),
          },
        }),
    ...(whatsappRoutes === undefined ? {} : { whatsapp: whatsappRoutes }),
    readiness: {
      database: () => infrastructure.database.check(),
      redis: () => infrastructure.redis.check(),
    },
    admin: {
      apiKey: config.ADMIN_API_KEY,
      clients: new ClientService(clientRepository),
      attendance,
    },
  });

  const stop = (signal: string): void => {
    app.log.info({ signal }, 'encerrando servidor');
    shutdown(app, infrastructure, app.log).then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, 'falha ao encerrar servidor');
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', () => {
    stop('SIGINT');
  });
  process.once('SIGTERM', () => {
    stop('SIGTERM');
  });

  try {
    await app.listen({ host: config.HOST, port: config.PORT });
  } catch (err) {
    app.log.error({ err, host: config.HOST, port: config.PORT }, 'falha ao iniciar o servidor');
    await closeInfrastructure(infrastructure, logger);
    process.exit(1);
  }
}

void main();
