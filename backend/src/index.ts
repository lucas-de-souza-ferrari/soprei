import { AttendanceService } from './application/attendance/attendance.service.js';
import { InventoryService } from './application/inventory/inventory.service.js';
import { KnowledgeService } from './application/knowledge/knowledge.service.js';
import { SampleDataService } from './application/knowledge/sample.service.js';
import { ChannelConnectionService } from './application/channel/channel-connection.service.js';
import { ChannelCredentialsService } from './application/channel/channel-credentials.service.js';
import { ChannelInboundProcessor } from './application/channel/channel-inbound.processor.js';
import { ChannelIntakeService } from './application/channel/channel-intake.service.js';
import { CompanyService } from './application/companies/company.service.js';
import { createAuthRedis } from './infrastructure/auth/auth-redis.js';
import { createAuthComponents, warmUpAuth } from './infrastructure/auth/create-auth.js';
import { createRateLimitRedis } from './infrastructure/cache/rate-limit-redis.js';
import { getRedis } from './infrastructure/cache/redis.client.js';
import {
  batchSettings,
  loadConfig,
  queueSettings,
  trustProxyMode,
  whatsappChannelConfig,
} from './infrastructure/config/index.js';
import {
  getDatabase,
  PrismaAttendanceUnitOfWork,
  PrismaChannelConnectionRepository,
  PrismaChannelUnitOfWork,
  PrismaCompanyRepository,
  PrismaInventoryLedger,
  PrismaKnowledgeDocumentRepository,
  PrismaKnowledgeRetriever,
  PrismaConversationRepository,
  PrismaMessageRepository,
  PrismaProductRepository,
  PrismaStockMovementRepository,
} from './infrastructure/database/index.js';
import { createLlmProvider } from './infrastructure/external-apis/llm/create-llm-provider.js';
import { WhatsappGraphAdminClient } from './infrastructure/external-apis/whatsapp/whatsapp-graph-admin.client.js';
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
import {
  AesGcmCredentialCipher,
  parseCredentialKeys,
} from './infrastructure/security/aes-gcm-credential-cipher.js';
import { createInboundQueue } from './infrastructure/queue/inbound-queue.js';

/** Espera da conexão Redis do rate limit no boot; passou disso, segue em fail-open com `warn`. */
const RATE_LIMIT_READY_TIMEOUT_MS = 2_000;
/** Espera da conexão Redis das sessões no boot; passou disso, as rotas autenticadas respondem 503 até subir. */
const AUTH_REDIS_READY_TIMEOUT_MS = 2_000;

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

  // Conexão própria das sessões (spec 007): fail-closed, sem fila offline e com prazo curto.
  const authRedis = createAuthRedis(config, logger);
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
    authRedis,
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
  if (!(await authRedis.waitUntilReady(AUTH_REDIS_READY_TIMEOUT_MS))) {
    // Fail-closed: até a conexão subir, login, refresh e rotas autenticadas respondem 503.
    logger.warn('conexão Redis de autenticação ainda não está pronta; rotas autenticadas em 503');
  }
  if (config.TRUST_PROXY === true) {
    logger.warn(
      'TRUST_PROXY=true confia em toda a cadeia X-Forwarded-For (o chamador escolhe o IP); use só em ambiente fechado',
    );
  }

  const { prisma } = infrastructure.database;
  const companyRepository = new PrismaCompanyRepository(prisma);
  const auth = createAuthComponents({
    config,
    logger,
    prisma,
    authRedis,
    metrics,
  });
  await warmUpAuth(auth);
  const attendance = new AttendanceService({
    companies: companyRepository,
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
    // Base de conhecimento da empresa (spec 026): recuperação por busca textual, fail-open.
    knowledge: new PrismaKnowledgeRetriever(prisma),
  });
  const documents = new PrismaKnowledgeDocumentRepository(prisma);
  const products = new PrismaProductRepository(prisma);
  const knowledge = new KnowledgeService(documents);
  const inventory = new InventoryService({
    products,
    movements: new PrismaStockMovementRepository(prisma),
    ledger: new PrismaInventoryLedger(prisma),
  });
  const sample = new SampleDataService({ documents, products, knowledge, inventory });

  let whatsappRoutes: WhatsappRoutesParams | undefined;
  let channelService: ChannelConnectionService | undefined;
  if (whatsapp !== undefined && inboundQueue !== undefined) {
    const channelLogger = logger;
    // Credenciais por empresa (spec 015): a config já validou as chaves; aqui só se monta a cifra.
    const parsedKeys = parseCredentialKeys(whatsapp.credentialKeys);
    if (!parsedKeys.ok) throw new Error('CHANNEL_CREDENTIALS_KEYS inválida');
    const cipher = new AesGcmCredentialCipher(parsedKeys.keys, whatsapp.credentialActiveKeyId);
    const connections = new PrismaChannelConnectionRepository(prisma);
    channelService = new ChannelConnectionService({
      companies: companyRepository,
      connections,
      unitOfWork: new PrismaChannelUnitOfWork(prisma),
      cipher,
      provisioner: new WhatsappGraphAdminClient({
        baseUrl: whatsapp.apiBaseUrl,
        graphApiVersion: whatsapp.graphApiVersion,
        appId: whatsapp.appId,
        appSecret: whatsapp.appSecret,
        timeoutMs: whatsapp.sendTimeoutMs,
      }),
      appId: whatsapp.appId,
      logger,
      metrics,
    });
    const processor = new ChannelInboundProcessor({
      attendance,
      companies: companyRepository,
      messages: new PrismaMessageRepository(prisma),
      sender: new WhatsappCloudApiClient({
        baseUrl: whatsapp.apiBaseUrl,
        graphApiVersion: whatsapp.graphApiVersion,
        timeoutMs: whatsapp.sendTimeoutMs,
        metrics,
      }),
      credentials: new ChannelCredentialsService({
        companies: companyRepository,
        connections,
        cipher,
        legacyToken: whatsapp.legacyAccessToken,
        metrics,
      }),
      connections,
      metrics,
      queue: inboundQueue.queue,
      batch: batchSettings(config),
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
        companies: companyRepository,
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
        legacyTokenConfigured: whatsapp.legacyAccessToken !== undefined,
      },
      'canal WhatsApp habilitado',
    );
  }

  // Um só mailer SMTP para contas (confirmação, recuperação) e convites; só com contas globais ligadas.
  const accountMailer = config.ACCOUNTS_ENABLED
    ? new SmtpVerificationMailer(smtpMailerOptions(config))
    : undefined;
  const app = buildServer({
    ...(config.ACCOUNTS_ENABLED && accountMailer !== undefined
      ? {
          accounts: {
            service: new AccountService({
              accounts: new PrismaAccountRepository(prisma),
              passwords: auth.hasher,
              sessions: new RedisAccountSessionStore(
                authRedis.client,
                versionedAuthPrefix(config.AUTH_REDIS_PREFIX, true),
              ),
              loginLocks: auth.sessions,
              loginSecret: deriveLoginLockSecret(config.JWT_SECRET),
              // Só id e resultado: nunca e-mail, código nem credenciais SMTP.
              onVerificationMail: (result, accountId) => {
                metrics.countVerificationEmail(result);
                if (result === 'failed') {
                  logger.warn({ accountId, result }, 'falha ao enviar confirmação de e-mail');
                } else {
                  logger.info({ accountId, result }, 'confirmação de e-mail enviada');
                }
              },
              // Só id e resultado: nunca código, hash, e-mail nem senha.
              onVerificationAttempt: (result, accountId) => {
                metrics.countVerificationAttempt(result);
                if (result === 'exhausted') {
                  logger.warn({ accountId, result }, 'código de confirmação esgotado');
                } else if (result === 'verified') {
                  logger.info({ accountId, result }, 'e-mail confirmado');
                }
              },
              // Recuperação de senha (spec 021): só resultados e ids, nunca e-mail, código nem senha.
              onPasswordResetRequest: (result) => {
                metrics.countPasswordResetRequest(result);
              },
              onPasswordReset: (result, accountId) => {
                metrics.countPasswordResetAttempt(result);
                if (result === 'reset') {
                  logger.info({ accountId, result }, 'senha redefinida');
                } else if (result === 'exhausted' || result === 'revoke_failed') {
                  logger.warn({ accountId, result }, 'redefinição de senha recusada');
                }
              },
              onPasswordResetMail: (kind, result, accountId) => {
                metrics.countPasswordResetEmail(kind, result);
                if (result === 'failed') {
                  logger.warn({ accountId, kind, result }, 'falha ao enviar e-mail da recuperação');
                }
              },
              onWarning: (event, accountId) => {
                logger.warn(
                  { accountId, event },
                  'bloqueio de login não zerado depois da redefinição',
                );
              },
              mailer: accountMailer,
            }),
            // Convites por e-mail (spec 025): sem variável nova; só id e enum em log e métrica.
            invitations: new InvitationService({
              invitations: new PrismaCompanyInvitationRepository(prisma),
              companies: companyRepository,
              accounts: new PrismaAccountRepository(prisma),
              unitOfWork: new PrismaInvitationUnitOfWork(prisma),
              hasher: auth.hasher,
              mailer: accountMailer,
              quota: new RedisInvitationQuotaStore(
                authRedis.client,
                versionedAuthPrefix(config.AUTH_REDIS_PREFIX, true),
              ),
              logger,
              metrics,
              loginSecret: deriveLoginLockSecret(config.JWT_SECRET),
              appOrigin: config.APP_ORIGIN ?? '',
            }),
            origin: config.APP_ORIGIN ?? '',
            secure: cookieIsSecure(config.NODE_ENV, config.APP_ORIGIN ?? ''),
          },
        }
      : {}),
    logger,
    metrics,
    metricsToken: config.METRICS_TOKEN,
    auth: auth.service,
    membershipAdmin: auth.membershipAdmin,
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
      companies: new CompanyService(companyRepository),
      attendance,
      knowledge,
      inventory,
      sample,
      ...(channelService === undefined ? {} : { channel: channelService }),
      ...(whatsapp === undefined
        ? {}
        : {
            channelSetup: {
              appId: whatsapp.appId,
              embeddedSignupConfigId: whatsapp.embeddedSignupConfigId,
              graphApiVersion: whatsapp.graphApiVersion,
              manualConnect: whatsapp.manualConnectEnabled,
            },
          }),
    },
  });

  // Expurgo de contas nunca confirmadas (spec 021): timer no processo, `unref`, desligável com 0.
  const purger = new UnverifiedAccountPurger({
    repository: new PrismaUnverifiedAccountPurgeRepository(prisma),
    retentionDays: config.ACCOUNT_UNVERIFIED_RETENTION_DAYS,
    // Só contagens: nunca e-mail nem id de conta.
    onRun: ({ result, purged, batches }) => {
      metrics.countAccountPurgeRun(result);
      metrics.countAccountsPurged(purged);
      if (result === 'error') {
        logger.error({ purged, batches }, 'falha no expurgo de contas não confirmadas');
      } else if (purged > 0) {
        logger.info({ purged, batches }, 'contas não confirmadas expurgadas');
      }
    },
  });
  // Expurgo do e-mail dos convites pendentes vencidos há 7 dias (spec 025): mesmo ciclo de vida.
  const invitationPurger = new InvitationExpiryPurger({
    repository: new PrismaInvitationExpiryRepository(prisma),
    // Só contagens: nunca e-mail nem id.
    onRun: ({ result, expired, batches }) => {
      metrics.countCompanyInvitation('purge', result === 'ok' ? 'ok' : 'error');
      if (result === 'error') {
        logger.error({ expired, batches }, 'falha no expurgo de convites vencidos');
      } else if (expired > 0) {
        logger.info({ expired, batches }, 'convites vencidos expurgados');
      }
    },
  });
  infrastructure.accountPurge = startPurgeTimer({
    enabled: config.ACCOUNTS_ENABLED,
    run: async () => {
      await purger.runOnce();
      await invitationPurger.runOnce();
    },
    intervalMinutes: config.ACCOUNT_PURGE_INTERVAL_MINUTES,
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
import { cookieIsSecure } from './presentation/auth/account.controller.js';
import { AccountService } from './application/auth/account.service.js';
import { deriveLoginLockSecret } from './application/auth/auth.service.js';
import {
  PrismaAccountRepository,
  PrismaCompanyInvitationRepository,
  PrismaInvitationExpiryRepository,
  PrismaInvitationUnitOfWork,
  PrismaUnverifiedAccountPurgeRepository,
} from './infrastructure/database/index.js';
import { InvitationExpiryPurger } from './application/invitations/invitation-expiry-purger.js';
import { InvitationService } from './application/invitations/invitation.service.js';
import { RedisInvitationQuotaStore } from './infrastructure/auth/redis-invitation-quota.js';
import { startPurgeTimer } from './application/auth/purge-timer.js';
import { UnverifiedAccountPurger } from './application/auth/unverified-account-purger.js';
import { versionedAuthPrefix } from './infrastructure/auth/auth-version.js';
import { RedisAccountSessionStore } from './infrastructure/auth/redis-account-session-store.js';
import { smtpMailerOptions } from './infrastructure/config/email.js';
import { SmtpVerificationMailer } from './infrastructure/external-apis/email/smtp-verification-mailer.js';
