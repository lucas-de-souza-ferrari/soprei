import { AttendanceService } from './application/attendance/attendance.service.js';
import { BillingNoticeService } from './application/billing/billing-notice.service.js';
import { BillingService } from './application/billing/billing.service.js';
import { CheckoutService } from './application/billing/checkout.service.js';
import { PaymentReconciler } from './application/billing/payment-reconciler.js';
import { deriveWebhookSecret } from './application/billing/webhook-token.js';
import { PaymentVerifier } from './application/billing/payment-verifier.js';
import { PendingReplyResumer } from './application/billing/pending-reply-resumer.js';
import { InfinitepayClient } from './infrastructure/external-apis/infinitepay/infinitepay.client.js';
import { SecretString } from './shared/types/index.js';
import { OnboardingService } from './application/onboarding/onboarding.service.js';
import { InventoryService } from './application/inventory/inventory.service.js';
import { ContactSchedulingService } from './application/schedule/contact-scheduling.service.js';
import { ScheduleSampleService } from './application/schedule/sample.service.js';
import { ScheduleService } from './application/schedule/schedule.service.js';
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
  PrismaAppointmentRepository,
  PrismaAvailabilityRuleRepository,
  PrismaInventoryLedger,
  PrismaContactScheduleUnitOfWork,
  PrismaScheduleAvailabilityReader,
  PrismaScheduleResourceRepository,
  PrismaScheduleServiceRepository,
  PrismaScheduleSettingsRepository,
  PrismaKnowledgeDocumentRepository,
  PrismaKnowledgeRetriever,
  PrismaConversationRepository,
  PrismaMessageRepository,
  PrismaProductRepository,
  PrismaOnboardingStore,
  PrismaStockMovementRepository,
  PrismaBillingNoticeRepository,
  PrismaBillingRepository,
  PrismaCheckoutRepository,
  PrismaPendingReplyReader,
  PrismaEntitlementReader,
  PrismaUsageMeter,
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
  // Um só mailer SMTP para contas (confirmação, recuperação) e convites e avisos de cobrança; só com contas globais ligadas.
  const accountMailer = config.ACCOUNTS_ENABLED
    ? new SmtpVerificationMailer(smtpMailerOptions(config))
    : undefined;
  // Planos e assinaturas (spec 031): só com BILLING_ENABLED. Desligada, nada abaixo é criado e o atendimento e
  // as rotas têm exatamente o comportamento e o custo de antes.
  const billing = config.BILLING_ENABLED
    ? {
        settings: {
          graceDays: config.BILLING_GRACE_DAYS,
          trialDays: config.BILLING_TRIAL_DAYS,
          trialTokens: config.BILLING_TRIAL_TOKENS,
        },
        entitlements: new PrismaEntitlementReader(prisma, {
          graceDays: config.BILLING_GRACE_DAYS,
          trialDays: config.BILLING_TRIAL_DAYS,
          trialTokens: config.BILLING_TRIAL_TOKENS,
        }),
        usage: new PrismaUsageMeter(prisma),
      }
    : undefined;
  // Checkout da InfinitePay (spec 031, E3): só com BILLING_ENABLED e CHECKOUT_ENABLED; a config já exigiu as
  // variáveis INFINITEPAY_*. Sem a fila do canal não há o que reativar (o canal ligado é que cria a fila).
  const checkout =
    billing !== undefined &&
    config.CHECKOUT_ENABLED &&
    config.INFINITEPAY_API_KEY !== undefined &&
    config.INFINITEPAY_HANDLE !== undefined &&
    config.INFINITEPAY_WEBHOOK_BASE_URL !== undefined &&
    config.APP_ORIGIN !== undefined
      ? (() => {
          const repository = new PrismaCheckoutRepository(prisma);
          const provider = new InfinitepayClient({
            baseUrl: config.INFINITEPAY_API_BASE_URL,
            apiKey: new SecretString(config.INFINITEPAY_API_KEY),
            handle: config.INFINITEPAY_HANDLE,
            timeoutMs: config.BILLING_HTTP_TIMEOUT_MS,
            checkoutHost: config.INFINITEPAY_CHECKOUT_HOST,
          });
          // Avisos de cobrança por e-mail (E5): só com o mailer das contas (BILLING_ENABLED exige ACCOUNTS_ENABLED).
          const notices =
            accountMailer === undefined
              ? undefined
              : new BillingNoticeService({
                  repository: new PrismaBillingNoticeRepository(prisma),
                  mailer: accountMailer,
                  logger,
                  metrics,
                  settings: {
                    graceDays: config.BILLING_GRACE_DAYS,
                    trialTokens: config.BILLING_TRIAL_TOKENS,
                    appOrigin: config.APP_ORIGIN,
                  },
                });
          const verifier = new PaymentVerifier({
            ...(notices === undefined ? {} : { notifier: notices }),
            checkout: repository,
            provider,
            graceDays: config.BILLING_GRACE_DAYS,
            logger,
            metrics,
            ...(inboundQueue === undefined
              ? {}
              : {
                  resumer: new PendingReplyResumer({
                    reader: new PrismaPendingReplyReader(prisma),
                    queue: inboundQueue.queue,
                    logger,
                  }),
                }),
          });
          return {
            verifier,
            notices,
            reconciler: new PaymentReconciler({ checkout: repository, verifier, logger }),
            service: new CheckoutService({
              billing: new PrismaBillingRepository(prisma),
              checkout: repository,
              provider,
              verifier,
              settings: {
                graceDays: config.BILLING_GRACE_DAYS,
                appOrigin: config.APP_ORIGIN,
                webhookBaseUrl: config.INFINITEPAY_WEBHOOK_BASE_URL,
                allowSopreiPaysMeta: config.SOPREI_PAYS_META_ENABLED,
                webhookSecret: deriveWebhookSecret(config.JWT_SECRET),
                sendCustomerEmail: config.CHECKOUT_SEND_CUSTOMER_EMAIL,
              },
              logger,
              metrics,
            }),
          };
        })()
      : undefined;
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
      scheduleAiEnabled: config.SCHEDULE_AI_ENABLED,
    },
    ...(billing === undefined ? {} : { entitlements: billing.entitlements, usage: billing.usage }),
    // Base de conhecimento da empresa (spec 026): recuperação por busca textual, fail-open.
    knowledge: new PrismaKnowledgeRetriever(prisma),
    // Horários livres da agenda (spec 027): só leitura, fail-open.
    schedule: new PrismaScheduleAvailabilityReader(prisma),
    // Escritas da IA na agenda (spec 028, E2/E3): só com a chave global e a opção da empresa; cotas no Redis.
    ...(config.SCHEDULE_AI_ENABLED
      ? {
          scheduling: new ContactSchedulingService({
            unitOfWork: new PrismaContactScheduleUnitOfWork(prisma),
            quota: new RedisScheduleAiQuotaStore(
              authRedis.client,
              versionedAuthPrefix(config.AUTH_REDIS_PREFIX, config.ACCOUNTS_ENABLED),
            ),
            quotaSecret: deriveLoginLockSecret(config.JWT_SECRET),
            logger,
          }),
        }
      : {}),
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
  // Agenda da empresa (spec 027): a dupla reserva é impedida pelo banco (restrição de exclusão).
  const scheduleSettings = new PrismaScheduleSettingsRepository(prisma);
  const scheduleResources = new PrismaScheduleResourceRepository(prisma);
  const scheduleServices = new PrismaScheduleServiceRepository(prisma);
  const scheduleRules = new PrismaAvailabilityRuleRepository(prisma);
  const scheduleSample = new ScheduleSampleService({
    settings: scheduleSettings,
    resources: scheduleResources,
    services: scheduleServices,
    rules: scheduleRules,
  });
  const schedule = new ScheduleService({
    settings: scheduleSettings,
    resources: scheduleResources,
    services: scheduleServices,
    rules: scheduleRules,
    appointments: new PrismaAppointmentRepository(prisma),
    logger,
    metrics,
  });

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
      ...(billing === undefined ? {} : { usage: billing.usage }),
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
              ...(billing === undefined
                ? {}
                : {
                    billing: {
                      trialDays: billing.settings.trialDays,
                      graceDays: billing.settings.graceDays,
                    },
                  }),
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
                  event === 'login_lock_reset_failed'
                    ? 'bloqueio de login não zerado depois da redefinição'
                    : event === 'preselect_failed'
                      ? 'empresa não pré-selecionada no login'
                      : 'última empresa não gravada',
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
    ...(billing === undefined
      ? {}
      : {
          billing: {
            service: new BillingService({
              billing: new PrismaBillingRepository(prisma),
              settings: {
                ...billing.settings,
                allowSopreiPaysMeta: config.SOPREI_PAYS_META_ENABLED,
              },
            }),
            entitlements: billing.entitlements,
            ...(checkout === undefined ? {} : { checkout: checkout.service }),
          },
        }),
    readiness: {
      database: () => infrastructure.database.check(),
      redis: () => infrastructure.redis.check(),
    },
    admin: {
      companies: new CompanyService(companyRepository),
      onboarding: new OnboardingService(new PrismaOnboardingStore(prisma)),
      attendance,
      knowledge,
      inventory,
      sample,
      schedule,
      scheduleSample,
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
  if (checkout !== undefined) {
    // Reconciliação de pagamentos (spec 031, E3): o webhook pode não chegar. Timer PRÓPRIO (padrão 10 min;
    // 0 desliga só ela) e independente do expurgo de contas; parado no closeInfrastructure junto com o dele.
    const reconcileTimer = startPurgeTimer({
      enabled: true,
      run: () => checkout.reconciler.runOnce(),
      intervalMinutes: config.BILLING_RECONCILE_INTERVAL_MINUTES,
    });
    // Avisos de cobrança por e-mail (E5): timer PRÓPRIO (padrão 60 min; 0 desliga só ele), sem sobreposição.
    const noticeTimer = startPurgeTimer({
      enabled: checkout.notices !== undefined,
      run: () => checkout.notices?.runOnce() ?? Promise.resolve(),
      intervalMinutes: config.BILLING_NOTICE_INTERVAL_MINUTES,
    });
    const purgeTimer = infrastructure.accountPurge;
    infrastructure.accountPurge = {
      async stop() {
        // allSettled: se um dos timers falhar ao parar, os outros e o drain ainda rodam.
        const results = await Promise.allSettled([
          purgeTimer?.stop(),
          reconcileTimer?.stop(),
          noticeTimer?.stop(),
        ]);
        // O desligamento também espera as confirmações em segundo plano (webhook já respondido).
        await checkout.verifier.drain();
        const failed = results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      },
    };
  }

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
import { RedisScheduleAiQuotaStore } from './infrastructure/auth/redis-schedule-ai-quota.js';
import { RedisAccountSessionStore } from './infrastructure/auth/redis-account-session-store.js';
import { smtpMailerOptions } from './infrastructure/config/email.js';
import { SmtpVerificationMailer } from './infrastructure/external-apis/email/smtp-verification-mailer.js';
