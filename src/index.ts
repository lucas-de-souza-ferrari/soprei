import { AttendanceService } from './application/attendance.service.js';
import { ClientService } from './application/client.service.js';
import { getRedis } from './infrastructure/cache/redis.client.js';
import { loadConfig } from './infrastructure/config/index.js';
import {
  getDatabase,
  PrismaAttendanceUnitOfWork,
  PrismaClientRepository,
  PrismaConversationRepository,
  PrismaMessageRepository,
} from './infrastructure/database/index.js';
import { createLlmProvider } from './infrastructure/external-apis/llm/create-llm-provider.js';
import { buildServer } from './infrastructure/http/server.js';
import {
  closeInfrastructure,
  type Infrastructure,
  shutdown,
  verifyInfrastructure,
} from './infrastructure/lifecycle.js';
import { createLogger } from './infrastructure/logger/logger.js';
import { createMetrics } from './infrastructure/metrics/index.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  const metrics = createMetrics();

  const infrastructure: Infrastructure = {
    database: getDatabase({
      config,
      logger,
      queryObserver: (sample) => {
        metrics.observeDbQuery(sample);
      },
    }),
    redis: getRedis({ config, logger }),
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

  const app = buildServer({
    logger,
    metrics,
    metricsToken: config.METRICS_TOKEN,
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
