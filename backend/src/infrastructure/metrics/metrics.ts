import type {
  AuditAction,
  BillingNoticeKind,
  Permission,
  QuotaBlockReason,
} from '../../domain/index.js';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

/** Fotografia do pool de conexões (mesma forma de `Database.poolMetrics()`). */
export interface PoolSnapshot {
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
}

export interface HttpRequestSample {
  readonly method: string;
  /** Padrão da rota, ou `unmatched`. Nunca a URL crua. */
  readonly route: string;
  readonly statusCode: number;
  readonly durationSeconds: number;
}

/**
 * Resultado de uma chamada ao LLM: `ok`, `error` (falha ou resposta inutilizável), `timeout`,
 * `refusal` (o modelo recusou) ou `truncated` (resposta cortada por limite de tokens).
 */
export type LlmRequestResult = 'ok' | 'error' | 'timeout' | 'refusal' | 'truncated';

/** Tipo de token contado em `llm_tokens_total` (conjunto fixo). */
export type LlmTokenType = 'input' | 'output' | 'cache_read';

export interface LlmTokensSample {
  readonly provider: string;
  readonly type: LlmTokenType;
  readonly tokens: number;
}

export interface LlmRequestSample {
  /** Nome do provedor (`mock`...): conjunto pequeno e fixo, nunca dado do usuário. */
  readonly provider: string;
  readonly result: LlmRequestResult;
  readonly durationSeconds: number;
}

/** Resultado de uma resposta de lote (spec 013): `answered`, `empty` (nada pendente) ou `capped` (sobrou excedente). */
export type BatchResult = 'answered' | 'empty' | 'capped';

export interface BatchSample {
  /** Quantas mensagens do contato a resposta juntou (0 em `empty`). */
  readonly size: number;
  readonly result: BatchResult;
}

/** Resultado de uma requisição ao webhook do canal (spec 011). Conjunto fixo. */
export type WebhookRequestResult =
  | 'verification_ok'
  | 'verification_failed'
  | 'ok'
  | 'invalid_signature'
  | 'invalid_payload'
  | 'enqueue_failed';

/** Destino de uma mensagem de entrada do canal (spec 011). Conjunto fixo. */
export type ChannelInboundResult =
  | 'enqueued'
  | 'unknown_number'
  | 'company_unavailable'
  | 'unsupported_type'
  | 'invalid_text'
  | 'missing_sender'
  | 'invalid_message'
  | 'ignored_type';

export type ChannelSendResult = 'ok' | 'error';

/** Operações de conexão do canal (spec 015) e seus resultados (conjuntos fixos). */
export type ChannelConnectionAction =
  'connect' | 'replace_token' | 'embedded_signup' | 'disconnect';
export type ChannelConnectionResult =
  | 'ok'
  | 'invalid_token'
  | 'invalid_code'
  | 'wrong_app'
  | 'missing_scope'
  | 'number_not_in_waba'
  | 'number_in_use'
  | 'registration_failed'
  | 'graph_error'
  | 'unsubscribe_failed';
/** Mudança de persona pela própria empresa (spec 023): conjunto fixo. */
export type PersonaUpdateAction = 'set' | 'cleared';
/** Assistente de primeiros passos (spec 030): conjunto fixo; nunca id nem passo. */
export type OnboardingMetricAction = 'dismissed' | 'reopened';

/** Operação de convite (spec 025). Conjunto fixo; nunca e-mail, id nem token. */
export type InvitationMetricAction =
  'create' | 'resend' | 'revoke' | 'preview' | 'accept' | 'accept_new' | 'purge';
export type InvitationMetricResult =
  'ok' | 'invalid' | 'forbidden' | 'limited' | 'conflict' | 'mismatch' | 'error';
export type InvitationEmailResult = 'sent' | 'failed' | 'skipped';
export type ChannelCredentialErrorReason = 'malformed' | 'unknown_key' | 'tampered';

export interface ChannelSendSample {
  /** Canal (`whatsapp`): conjunto pequeno e fixo, nunca dado do usuário. */
  readonly channel: string;
  readonly result: ChannelSendResult;
  readonly durationSeconds: number;
}

/** Estados de job expostos em `queue_jobs` (spec 034; conjunto fixo). */
export const QUEUE_JOB_STATES = ['waiting', 'active', 'delayed', 'failed'] as const;
/** Tipos de job da fila do canal (label `kind`; conjunto fixo). */
export type QueueJobKind = 'text' | 'notice' | 'flush';
/** Prazo da leitura das contagens da fila durante a coleta de `/metrics`. */
export const QUEUE_COUNTS_TIMEOUT_MS = 1_000;
/** De 5 ms a 60 s: cobre o aceite (banco) e o turno inteiro (modelo + envio). */
export const QUEUE_JOB_DURATION_BUCKETS: readonly number[] = [
  0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60,
];
/** De 10 ms a 5 min: espera na fila além do atraso agendado. */
export const QUEUE_JOB_WAIT_BUCKETS: readonly number[] = [
  0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300,
];

/** Erro fatal do processo (spec 034). */
export type ProcessFatalErrorKind = 'unhandled_rejection' | 'uncaught_exception';

/** Resultado de um job da fila: `completed`, `retried`, `failed` ou `discarded`. */
export type QueueJobResult = 'completed' | 'retried' | 'failed' | 'discarded';

/** Status de entrega informado pelo canal (`other` agrupa qualquer valor desconhecido). */
export type ChannelStatusEvent = 'sent' | 'delivered' | 'read' | 'played' | 'failed' | 'other';

/** Resultado de um login (spec 007): `ok`, `invalid` (qualquer credencial recusada) ou `locked`. */
export type AuthLoginResult = 'ok' | 'invalid' | 'locked';
export type AuthLoginKind = 'membership' | 'platform';
export type AuthRefreshResult = 'ok' | 'invalid' | 'reuse' | 'unavailable';
export type AuthTokenRejectionReason =
  'missing' | 'malformed' | 'invalid' | 'expired' | 'revoked' | 'unavailable';
export type AuthLogoutScope = 'session' | 'all';
/** Envio do código de confirmação de e-mail em segundo plano (spec 017). */
export type VerificationEmailResult = 'sent' | 'failed';
/** Tentativa de confirmar o e-mail com o código de 6 dígitos (spec 020). Conjunto fixo. */
export type VerificationAttemptResult = 'verified' | 'wrong' | 'exhausted' | 'unavailable';

/** Pedido de código de recuperação de senha (spec 021): gravou código ou foi ignorado. */
export type PasswordResetRequestResult = 'issued' | 'ignored';
/** Tentativa de redefinir a senha (spec 021). Conjunto fixo. */
export type PasswordResetAttemptResult =
  'reset' | 'wrong' | 'exhausted' | 'unavailable' | 'revoke_failed';
export type PasswordResetEmailKind = 'code' | 'notice';
/** Execução do expurgo de contas não confirmadas (spec 021). */
export type AccountPurgeRunResult = 'ok' | 'error';
/** Pedidos de pagamento (spec 031, E3). Conjuntos fixos: nunca id, valor, e-mail nem link. */
export type BillingOrderKind = 'NEW' | 'RENEWAL' | 'UPGRADE' | 'EXTRA_PACK';
export type BillingOrderResult =
  | 'created'
  | 'link_failed'
  | 'provider_config'
  | 'limit'
  | 'rejected'
  | 'paid'
  | 'amount_mismatch'
  | 'reference_conflict'
  | 'upgrade_stale'
  | 'renewal_stale';
export type BillingWebhookResult =
  'recorded' | 'duplicate' | 'unknown_order' | 'bad_token' | 'throttled' | 'invalid' | 'error';
/** Resultado de um aviso de cobrança por e-mail (spec 031, E5). Conjunto fixo. */
export type BillingNoticeResult = 'sent' | 'failed' | 'skipped_recipient';
export type BillingNoticeRunResult = 'ok' | 'error';
export type BillingCheckResult =
  | 'paid'
  | 'already_paid'
  | 'not_paid'
  | 'amount_mismatch'
  | 'upgrade_stale'
  | 'renewal_stale'
  | 'unverifiable'
  | 'unknown_order'
  | 'ignored'
  | 'cooldown'
  | 'reference_conflict'
  | 'unavailable'
  | 'config_error'
  | 'rejected';

/** Recuperação da base de conhecimento (spec 026). Conjunto fixo: vai a label. */
export type KnowledgeRetrievalResult = 'hit' | 'empty' | 'skipped' | 'error' | 'timeout';

/** Operações da agenda (spec 027). Conjuntos fixos: nunca id, nome de serviço, contato nem horário. */
export type ScheduleAction =
  | 'create'
  | 'reschedule'
  | 'confirm'
  | 'cancel'
  | 'complete'
  | 'no_show'
  | 'label'
  | 'block'
  | 'unblock'
  | 'configure';
export type ScheduleActionResult = 'ok' | 'slot_taken' | 'conflict' | 'invalid';

/** Consulta de horários livres para o prompt da IA (spec 027, E3). */
export type ScheduleContextResult = 'hit' | 'empty' | 'skipped' | 'error' | 'timeout';

/** Ferramentas de agenda da IA (spec 028): conjuntos fixos; nunca argumento, resultado nem id. */
export type ScheduleToolLabel =
  | 'listar_horarios'
  | 'solicitar_agendamento'
  | 'cancelar_agendamento'
  | 'remarcar_agendamento'
  | 'unknown';
export type ScheduleToolCallResult =
  | 'ok'
  | 'slot_taken'
  | 'outside_rules'
  | 'not_found'
  | 'limit'
  | 'invalid_args'
  | 'unavailable'
  | 'turn_limit'
  | 'error';
export type ScheduleToolTurnResult =
  | 'used'
  | 'round_cap'
  | 'provider_error'
  | 'deterministic_summary'
  | 'guard_replaced'
  | 'disabled_fail_safe';

export interface DbQuerySample {
  readonly model: string;
  readonly operation: string;
  readonly durationSeconds: number;
}

/**
 * Métricas do processo. Há um `Registry` dedicado (não o global) para não vazar estado entre
 * testes; as próximas specs (rate limit, cache...) registram as suas métricas nele.
 *
 * Cardinalidade controlada: nenhum label com `companyId`, `membershipId`, id de recurso ou URL crua.
 */
export interface Metrics {
  readonly registry: Registry;
  /** Formato de texto do Prometheus. */
  readonly contentType: string;
  render(): Promise<string>;
  observeHttpRequest(sample: HttpRequestSample): void;
  observeDbQuery(sample: DbQuerySample): void;
  /** Uma chamada ao LLM terminou (spec 010). Sem `companyId` em label. */
  observeLlmRequest(sample: LlmRequestSample): void;
  /** Tokens de uma chamada ao LLM que respondeu (spec 014). Sem `companyId` nem texto em label. */
  observeLlmTokens(sample: LlmTokensSample): void;
  /** O contato recebeu o texto padrão de falha em vez de uma resposta do modelo. */
  countAttendanceFallback(): void;
  /** Uma resposta de lote terminou (spec 013). Sem `companyId`, telefone nem texto em label. */
  observeAttendanceBatch(sample: BatchSample): void;
  /** Um turno saiu com a resposta do turno anterior ainda sem `sentAt` (spec 013). Sem labels. */
  countUnsentReply(): void;
  /** Uma recuperação da base de conhecimento terminou (spec 026). Conjunto fixo; nunca a consulta. */
  countKnowledgeRetrieval(result: KnowledgeRetrievalResult): void;
  /** Uma operação da agenda terminou (spec 027). Conjunto fixo de labels. */
  countScheduleAction(action: ScheduleAction, result: ScheduleActionResult): void;
  /** Uma consulta de horários livres para o prompt terminou (spec 027). Conjunto fixo. */
  countScheduleContext(result: ScheduleContextResult): void;
  /** A IA deixou de responder por cota esgotada ou assinatura inativa (spec 031). Conjunto fixo. */
  countQuotaBlock(reason: QuotaBlockReason): void;
  /** Uma mensagem de saída ao contato foi contada na assinatura (spec 031). Sem labels. */
  countUsageSentMessage(): void;
  /** A medição de uso falhou e o fluxo seguiu (spec 031). Sem labels. */
  countUsageMeterError(): void;
  /** A leitura das cotas falhou e o atendimento seguiu sem limite (spec 031). Sem labels. */
  countEntitlementError(): void;
  /** Um pedido de pagamento mudou de situação (spec 031, E3). Conjuntos fixos. */
  countBillingOrder(kind: BillingOrderKind, result: BillingOrderResult): void;
  /** Um webhook da InfinitePay foi tratado (spec 031, E3). Conjunto fixo. */
  countBillingWebhook(result: BillingWebhookResult): void;
  /** Uma confirmação de pagamento por payment_check terminou (spec 031, E3). Conjunto fixo. */
  countBillingCheck(result: BillingCheckResult): void;
  /** Um aviso de cobrança por e-mail terminou (spec 031, E5). Conjuntos fixos; nenhum id, valor ou e-mail. */
  countBillingNotice(kind: BillingNoticeKind, result: BillingNoticeResult): void;
  /** Uma execução da tarefa periódica de avisos terminou (spec 031, E5). */
  countBillingNoticeRun(result: BillingNoticeRunResult): void;
  /** Uma chamada de ferramenta da agenda terminou (spec 028). */
  countScheduleToolCall(tool: ScheduleToolLabel, result: ScheduleToolCallResult): void;
  /** Um turno com ferramentas de agenda terminou (spec 028). */
  countScheduleToolTurn(result: ScheduleToolTurnResult): void;
  /** Rodadas de ferramenta de um turno com ferramentas oferecidas (spec 028). */
  observeScheduleToolRounds(rounds: number): void;
  /** Uma requisição ao webhook do canal terminou (spec 011). Sem telefone nem texto em label. */
  countWebhookRequest(channel: string, result: WebhookRequestResult): void;
  /** O destino de uma mensagem de entrada do canal. */
  countChannelInbound(channel: string, result: ChannelInboundResult): void;
  /** Um evento de status de entrega do canal (só contagem). */
  countChannelStatus(channel: string, status: ChannelStatusEvent): void;
  /** Um envio de mensagem ao canal terminou. */
  observeChannelSend(sample: ChannelSendSample): void;
  /** Uma operação de conexão do canal terminou (spec 015). Sem `companyId`, número, WABA nem token. */
  countChannelConnection(action: ChannelConnectionAction, result: ChannelConnectionResult): void;
  /** A conexão da empresa passou a `TOKEN_INVALID` (spec 015). */
  countChannelStateTransition(to: 'token_invalid'): void;
  /** Falha ao decifrar uma credencial guardada (spec 015). */
  countChannelCredentialError(reason: ChannelCredentialErrorReason): void;
  /** Um job da fila terminou (ou foi reagendado). `queue` é o nome fixo da fila. */
  countQueueJob(queue: string, result: QueueJobResult): void;
  /** Uma requisição foi recusada com 429 (spec 005). `profile` é um dos perfis fixos, nunca IP. */
  countRateLimitRejected(profile: string): void;
  /** O store (Redis) do rate limit falhou e a requisição passou em fail-open (spec 005). */
  countRateLimitStoreError(): void;
  /** Um login terminou (spec 007). Sem e-mail, slug nem IP em label. */
  countAuthLogin(kind: AuthLoginKind, result: AuthLoginResult): void;
  countAuthRefresh(result: AuthRefreshResult): void;
  /** O `authenticate` recusou um access token; `reason` é a categoria (nunca vai à resposta). */
  countAuthTokenRejection(reason: AuthTokenRejectionReason): void;
  countAuthLogout(scope: AuthLogoutScope): void;
  /** Um envio de confirmação de e-mail terminou (spec 017). Sem id, e-mail nem código em label. */
  countVerificationEmail(result: VerificationEmailResult): void;
  /** Uma tentativa de confirmar o e-mail terminou (spec 020). Sem id, e-mail, IP nem código. */
  countVerificationAttempt(result: VerificationAttemptResult): void;
  /** Um pedido de código de recuperação terminou (spec 021). Sem id, e-mail, IP nem código. */
  countPasswordResetRequest(result: PasswordResetRequestResult): void;
  /** Uma tentativa de redefinir a senha terminou (spec 021). Conjunto fixo, sem id nem e-mail. */
  countPasswordResetAttempt(result: PasswordResetAttemptResult): void;
  /** Um e-mail da recuperação (código ou aviso) foi enviado ou falhou (spec 021). */
  countPasswordResetEmail(kind: PasswordResetEmailKind, result: VerificationEmailResult): void;
  /** Contas não confirmadas apagadas por uma execução do expurgo (spec 021). */
  countAccountsPurged(count: number): void;
  /** Uma execução do expurgo terminou (spec 021). */
  countAccountPurgeRun(result: AccountPurgeRunResult): void;
  /** O hook `requirePermission` negou uma permissão (spec 008). `permission` é do conjunto fixo, nunca id. */
  countAuthzDenial(permission: Permission): void;
  /** Uma operação de gestão de usuários foi confirmada (spec 008). `action` é o `AuditAction`. */
  countMembershipAdminAction(action: AuditAction): void;
  /** A empresa gravou ou limpou a própria persona (spec 023). Nunca o texto nem o tamanho. */
  countCompanyPersonaUpdate(action: PersonaUpdateAction): void;
  /** A empresa dispensou ou reabriu o assistente de primeiros passos (spec 030). */
  countCompanyOnboardingAction(action: OnboardingMetricAction): void;
  /** Uma operação de convite terminou (spec 025). A razão detalhada de uma falha uniforme vai só aqui. */
  countCompanyInvitation(action: InvitationMetricAction, result: InvitationMetricResult): void;
  /** O e-mail de convite foi enviado, falhou ou foi pulado pela cota (spec 025). */
  countCompanyInvitationEmail(result: InvitationEmailResult): void;
  /** Liga os gauges do pool à fonte; eles são lidos só no momento da coleta (sem timers). */
  bindPool(source: () => PoolSnapshot): void;
  /**
   * Liga `queue_jobs{queue,state}` às contagens da fila (spec 034), lidas a cada `render` e com prazo
   * curto. Falha ou demora deixam o gauge sem amostra e contam `queue_metrics_errors_total`.
   */
  bindQueue(queue: string, source: () => Promise<Record<string, number>>): void;
  /** Um job rodou no handler: duração e, se informada, a espera na fila (spec 034). */
  observeQueueJob(
    queue: string,
    kind: QueueJobKind,
    sample: { readonly durationSeconds: number; readonly waitSeconds?: number },
  ): void;
  /** Erro fatal não tratado no processo (spec 034). */
  countProcessFatalError(kind: ProcessFatalErrorKind): void;
}

/** De 5 ms a 10 s. */
export const HTTP_DURATION_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

/** De 50 ms a 2 min: chamadas ao LLM são lentas (o prazo máximo da config é 120 s). */
export const LLM_DURATION_BUCKETS: readonly number[] = [
  0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 45, 120,
];

/** Mensagens por resposta de lote (spec 013): de 1 até o máximo configurável (50). */
export const BATCH_SIZE_BUCKETS: readonly number[] = [1, 2, 3, 5, 10, 25, 50];

/** De 1 ms a 5 s: queries costumam ser mais rápidas que requisições. */
export const DB_DURATION_BUCKETS: readonly number[] = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5,
];

function statusClass(statusCode: number): string {
  return `${String(Math.floor(statusCode / 100))}xx`;
}

export function createMetrics(): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const httpRequests = new Counter({
    name: 'http_requests_total',
    help: 'Total de requisições HTTP atendidas',
    labelNames: ['method', 'route', 'status_class'] as const,
    registers: [registry],
  });
  const httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duração das requisições HTTP em segundos',
    labelNames: ['method', 'route', 'status_class'] as const,
    buckets: [...HTTP_DURATION_BUCKETS],
    registers: [registry],
  });
  const dbDuration = new Histogram({
    name: 'db_query_duration_seconds',
    help: 'Duração das queries do Prisma em segundos, por model e operação',
    labelNames: ['model', 'operation'] as const,
    buckets: [...DB_DURATION_BUCKETS],
    registers: [registry],
  });

  const llmRequests = new Counter({
    name: 'llm_requests_total',
    help: 'Total de chamadas ao LLM, por provedor e resultado (ok, error, timeout, refusal, truncated)',
    labelNames: ['provider', 'result'] as const,
    registers: [registry],
  });
  const llmDuration = new Histogram({
    name: 'llm_request_duration_seconds',
    help: 'Duração das chamadas ao LLM em segundos, por provedor',
    labelNames: ['provider'] as const,
    buckets: [...LLM_DURATION_BUCKETS],
    registers: [registry],
  });
  const llmTokens = new Counter({
    name: 'llm_tokens_total',
    help: 'Total de tokens das chamadas ao LLM, por provedor e tipo (input, output, cache_read)',
    labelNames: ['provider', 'type'] as const,
    registers: [registry],
  });
  const attendanceFallbacks = new Counter({
    name: 'attendance_fallbacks_total',
    help: 'Total de respostas de fallback (texto padrão) enviadas por falha do LLM',
    registers: [registry],
  });

  const batchSize = new Histogram({
    name: 'attendance_batch_size',
    help: 'Mensagens do contato juntadas em cada resposta de lote do canal',
    buckets: [...BATCH_SIZE_BUCKETS],
    registers: [registry],
  });
  const batches = new Counter({
    name: 'attendance_batches_total',
    help: 'Respostas de lote do canal por resultado (answered, empty, capped)',
    labelNames: ['result'] as const,
    registers: [registry],
  });

  const unsentReplies = new Counter({
    name: 'attendance_unsent_replies_total',
    help: 'Turnos que responderam as pendentes com a resposta anterior gravada e ainda sem sentAt',
    registers: [registry],
  });

  const knowledgeRetrievals = new Counter({
    name: 'knowledge_retrievals_total',
    help: 'Recuperações da base de conhecimento por resultado (spec 026, conjunto fixo)',
    labelNames: ['result'] as const,
    registers: [registry],
  });

  const scheduleActions = new Counter({
    name: 'schedule_actions_total',
    help: 'Operações da agenda por ação e resultado (spec 027, conjuntos fixos)',
    labelNames: ['action', 'result'] as const,
    registers: [registry],
  });

  const scheduleContext = new Counter({
    name: 'schedule_context_total',
    help: 'Consultas de horários livres para o prompt da IA por resultado (spec 027, conjunto fixo)',
    labelNames: ['result'] as const,
    registers: [registry],
  });

  const quotaBlocks = new Counter({
    name: 'quota_blocks_total',
    help: 'Vezes em que a IA deixou de responder por cota ou assinatura inativa (spec 031, motivo fixo)',
    labelNames: ['reason'] as const,
    registers: [registry],
  });
  const usageSentMessages = new Counter({
    name: 'usage_sent_messages_total',
    help: 'Mensagens de saída ao contato contadas na assinatura (spec 031)',
    registers: [registry],
  });
  const usageMeterErrors = new Counter({
    name: 'usage_meter_errors_total',
    help: 'Falhas da medição de uso que não derrubaram o fluxo (spec 031)',
    registers: [registry],
  });
  const billingOrders = new Counter({
    name: 'billing_orders_total',
    help: 'Pedidos de pagamento por tipo e resultado (spec 031, conjuntos fixos)',
    labelNames: ['kind', 'result'] as const,
    registers: [registry],
  });
  const billingWebhooks = new Counter({
    name: 'billing_webhooks_total',
    help: 'Webhooks da InfinitePay por resultado (spec 031, conjunto fixo)',
    labelNames: ['result'] as const,
    registers: [registry],
  });
  const billingChecks = new Counter({
    name: 'billing_checks_total',
    help: 'Confirmações de pagamento (payment_check) por resultado (spec 031, conjunto fixo)',
    labelNames: ['result'] as const,
    registers: [registry],
  });
  const billingNotices = new Counter({
    name: 'billing_notices_total',
    help: 'Avisos de cobrança por e-mail por tipo e resultado (spec 031, conjuntos fixos)',
    labelNames: ['kind', 'result'] as const,
    registers: [registry],
  });
  const billingNoticeRuns = new Counter({
    name: 'billing_notice_runs_total',
    help: 'Execuções da tarefa de avisos de cobrança por resultado (spec 031, E5)',
    labelNames: ['result'] as const,
    registers: [registry],
  });
  const entitlementErrors = new Counter({
    name: 'entitlement_errors_total',
    help: 'Falhas na leitura das cotas; o atendimento seguiu sem limite (spec 031)',
    registers: [registry],
  });

  const scheduleToolCalls = new Counter({
    name: 'schedule_tool_calls_total',
    help: 'Chamadas de ferramenta de agenda da IA por ferramenta e resultado (spec 028, conjuntos fixos)',
    labelNames: ['tool', 'result'] as const,
    registers: [registry],
  });
  const scheduleToolTurns = new Counter({
    name: 'schedule_tool_turns_total',
    help: 'Turnos com ferramentas de agenda por resultado (spec 028, conjunto fixo)',
    labelNames: ['result'] as const,
    registers: [registry],
  });
  const scheduleToolRounds = new Histogram({
    name: 'schedule_tool_rounds',
    help: 'Rodadas de ferramenta por turno com ferramentas oferecidas (spec 028)',
    buckets: [0, 1, 2, 3],
    registers: [registry],
  });

  const rateLimitRejected = new Counter({
    name: 'rate_limit_rejected_total',
    help: 'Total de requisições recusadas com 429 pelo rate limit, por perfil',
    labelNames: ['profile'] as const,
    registers: [registry],
  });
  const rateLimitStoreErrors = new Counter({
    name: 'rate_limit_store_errors_total',
    help: 'Falhas do Redis no rate limit (a requisição passou em fail-open)',
    registers: [registry],
  });

  const webhookRequests = new Counter({
    name: 'webhook_requests_total',
    help: 'Requisições ao webhook do canal, por canal e resultado',
    labelNames: ['channel', 'result'] as const,
    registers: [registry],
  });
  const channelInbound = new Counter({
    name: 'channel_inbound_messages_total',
    help: 'Mensagens de entrada do canal, por canal e destino',
    labelNames: ['channel', 'result'] as const,
    registers: [registry],
  });
  const channelStatus = new Counter({
    name: 'channel_status_events_total',
    help: 'Eventos de status de entrega informados pelo canal, por canal e status',
    labelNames: ['channel', 'status'] as const,
    registers: [registry],
  });
  const channelSend = new Counter({
    name: 'channel_send_total',
    help: 'Envios de mensagem ao canal, por canal e resultado (ok, error)',
    labelNames: ['channel', 'result'] as const,
    registers: [registry],
  });
  const channelSendDuration = new Histogram({
    name: 'channel_send_duration_seconds',
    help: 'Duração dos envios de mensagem ao canal em segundos',
    labelNames: ['channel'] as const,
    buckets: [...HTTP_DURATION_BUCKETS],
    registers: [registry],
  });
  const channelConnections = new Counter({
    name: 'channel_connections_total',
    help: 'Operações de conexão do canal por ação e resultado',
    labelNames: ['action', 'result'] as const,
    registers: [registry],
  });
  const channelStateTransitions = new Counter({
    name: 'channel_state_transitions_total',
    help: 'Transições de estado da conexão do canal (to=token_invalid)',
    labelNames: ['to'] as const,
    registers: [registry],
  });
  const channelCredentialErrors = new Counter({
    name: 'channel_credential_errors_total',
    help: 'Falhas ao decifrar credenciais do canal, por motivo',
    labelNames: ['reason'] as const,
    registers: [registry],
  });
  const queueJobs = new Counter({
    name: 'queue_jobs_total',
    help: 'Jobs da fila por nome da fila e resultado (completed, retried, failed, discarded)',
    labelNames: ['queue', 'result'] as const,
    registers: [registry],
  });

  const authLogins = new Counter({
    name: 'auth_logins_total',
    help: 'Logins por tipo de identidade (membership, platform) e resultado (ok, invalid, locked)',
    labelNames: ['kind', 'result'] as const,
    registers: [registry],
  });
  const authRefresh = new Counter({
    name: 'auth_refresh_total',
    help: 'Renovações de sessão por resultado (ok, invalid, reuse, unavailable)',
    labelNames: ['result'] as const,
    registers: [registry],
  });
  const authTokenRejections = new Counter({
    name: 'auth_token_rejections_total',
    help: 'Access tokens recusados por categoria (missing, malformed, invalid, expired, revoked, unavailable)',
    labelNames: ['reason'] as const,
    registers: [registry],
  });
  const authLogouts = new Counter({
    name: 'auth_logouts_total',
    help: 'Logouts por escopo (session, all)',
    labelNames: ['scope'] as const,
    registers: [registry],
  });

  const verificationAttempts = new Counter({
    name: 'account_verification_attempts_total',
    help: 'Tentativas de confirmar o e-mail por resultado (verified, wrong, exhausted, unavailable)',
    labelNames: ['result'] as const,
    registers: [registry],
  });

  const verificationEmails = new Counter({
    name: 'account_verification_sends_total',
    help: 'Envios do código de confirmação da conta por resultado (sent, failed)',
    labelNames: ['result'] as const,
    registers: [registry],
  });

  const passwordResetRequests = new Counter({
    name: 'account_password_reset_requests_total',
    help: 'Pedidos de código de recuperação de senha por resultado (issued, ignored)',
    labelNames: ['result'] as const,
    registers: [registry],
  });
  const passwordResetAttempts = new Counter({
    name: 'account_password_reset_attempts_total',
    help: 'Tentativas de redefinir a senha por resultado (reset, wrong, exhausted, unavailable, revoke_failed)',
    labelNames: ['result'] as const,
    registers: [registry],
  });
  const passwordResetEmails = new Counter({
    name: 'account_password_reset_emails_total',
    help: 'E-mails da recuperação de senha por tipo (code, notice) e resultado (sent, failed)',
    labelNames: ['kind', 'result'] as const,
    registers: [registry],
  });
  const accountsPurged = new Counter({
    name: 'account_purged_total',
    help: 'Contas não confirmadas apagadas pelo expurgo',
    registers: [registry],
  });
  const accountPurgeRuns = new Counter({
    name: 'account_purge_runs_total',
    help: 'Execuções do expurgo de contas não confirmadas por resultado (ok, error)',
    labelNames: ['result'] as const,
    registers: [registry],
  });

  const authzDenials = new Counter({
    name: 'authz_denials_total',
    help: 'Negações de permissão pelo hook requirePermission, por permissão (conjunto fixo)',
    labelNames: ['permission'] as const,
    registers: [registry],
  });
  const membershipAdminActions = new Counter({
    name: 'membership_admin_actions_total',
    help: 'Operações de gestão de usuários confirmadas, por ação de auditoria (conjunto fixo)',
    labelNames: ['action'] as const,
    registers: [registry],
  });

  const companyPersonaUpdates = new Counter({
    name: 'company_persona_updates_total',
    help: 'Persona gravada ou limpa pela própria empresa (spec 023), por ação (conjunto fixo)',
    labelNames: ['action'] as const,
    registers: [registry],
  });

  const companyOnboardingActions = new Counter({
    name: 'company_onboarding_actions_total',
    help: 'Assistente de primeiros passos dispensado ou reaberto (spec 030), por ação (conjunto fixo)',
    labelNames: ['action'] as const,
    registers: [registry],
  });

  const companyInvitations = new Counter({
    name: 'company_invitations_total',
    help: 'Operações de convite por ação e resultado (spec 025, conjuntos fixos)',
    labelNames: ['action', 'result'] as const,
    registers: [registry],
  });
  const companyInvitationEmails = new Counter({
    name: 'company_invitation_emails_total',
    help: 'E-mails de convite por resultado (sent, failed, skipped)',
    labelNames: ['result'] as const,
    registers: [registry],
  });

  const queueJobDuration = new Histogram({
    name: 'queue_job_duration_seconds',
    help: 'Tempo de um job da fila dentro do handler, por fila e tipo (text, notice, flush)',
    labelNames: ['queue', 'kind'] as const,
    buckets: [...QUEUE_JOB_DURATION_BUCKETS],
    registers: [registry],
  });
  const queueJobWait = new Histogram({
    name: 'queue_job_wait_seconds',
    help: 'Espera de um job na fila além do atraso agendado, por fila e tipo',
    labelNames: ['queue', 'kind'] as const,
    buckets: [...QUEUE_JOB_WAIT_BUCKETS],
    registers: [registry],
  });
  const queueMetricsErrors = new Counter({
    name: 'queue_metrics_errors_total',
    help: 'Falhas ao ler as contagens da fila durante a coleta de métricas',
    registers: [registry],
  });
  const processFatalErrors = new Counter({
    name: 'process_fatal_errors_total',
    help: 'Erros fatais não tratados no processo por tipo (unhandled_rejection, uncaught_exception)',
    labelNames: ['kind'] as const,
    registers: [registry],
  });
  const queueSources = new Map<string, () => Promise<Record<string, number>>>();
  const queueJobsByState = new Gauge({
    name: 'queue_jobs',
    help: 'Jobs da fila por estado (waiting, active, delayed, failed)',
    labelNames: ['queue', 'state'] as const,
    registers: [registry],
  });
  /**
   * Lê as contagens das filas ligadas e atualiza `queue_jobs`. Roda em `render`, **antes** de o
   * registro serializar: o prom-client coleta as métricas em paralelo, então um contador
   * incrementado dentro do `collect` de outra métrica só apareceria na coleta seguinte.
   */
  const refreshQueueJobs = async (): Promise<void> => {
    // Sem amostra antiga: se a leitura falhar, a série some em vez de mostrar um valor velho.
    queueJobsByState.reset();
    for (const [queue, source] of queueSources) {
      let timer: NodeJS.Timeout | undefined;
      try {
        const counts = await Promise.race([
          source(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              reject(new Error('prazo da leitura da fila'));
            }, QUEUE_COUNTS_TIMEOUT_MS);
          }),
        ]);
        for (const state of QUEUE_JOB_STATES) {
          queueJobsByState.set({ queue, state }, counts[state] ?? 0);
        }
      } catch {
        // Nunca o erro em si (o ioredis anexa os argumentos do comando): só a contagem.
        queueMetricsErrors.inc();
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  };

  let poolSource: (() => PoolSnapshot) | undefined;
  new Gauge({
    name: 'db_pool_connections',
    help: 'Conexões do pool do PostgreSQL por estado (total, idle, waiting)',
    labelNames: ['state'] as const,
    registers: [registry],
    collect() {
      if (poolSource === undefined) return;
      const pool = poolSource();
      this.set({ state: 'total' }, pool.totalCount);
      this.set({ state: 'idle' }, pool.idleCount);
      this.set({ state: 'waiting' }, pool.waitingCount);
    },
  });

  return {
    registry,
    contentType: registry.contentType,
    render: async () => {
      await refreshQueueJobs();
      return registry.metrics();
    },
    observeHttpRequest({ method, route, statusCode, durationSeconds }) {
      const labels = { method, route, status_class: statusClass(statusCode) };
      httpRequests.inc(labels);
      httpDuration.observe(labels, durationSeconds);
    },
    observeDbQuery({ model, operation, durationSeconds }) {
      dbDuration.observe({ model, operation }, durationSeconds);
    },
    observeLlmRequest({ provider, result, durationSeconds }) {
      llmRequests.inc({ provider, result });
      llmDuration.observe({ provider }, durationSeconds);
    },
    observeLlmTokens({ provider, type, tokens }) {
      if (Number.isFinite(tokens) && tokens > 0) llmTokens.inc({ provider, type }, tokens);
    },
    countAttendanceFallback() {
      attendanceFallbacks.inc();
    },
    observeAttendanceBatch({ size, result }) {
      batches.inc({ result });
      // `empty` não é uma resposta: não entra no histograma de tamanho.
      if (size > 0) batchSize.observe(size);
    },
    countUnsentReply() {
      unsentReplies.inc();
    },
    countKnowledgeRetrieval(result) {
      knowledgeRetrievals.inc({ result });
    },
    countScheduleAction(action, result) {
      scheduleActions.inc({ action, result });
    },
    countScheduleContext(result) {
      scheduleContext.inc({ result });
    },
    countQuotaBlock(reason) {
      quotaBlocks.inc({ reason });
    },
    countUsageSentMessage() {
      usageSentMessages.inc();
    },
    countUsageMeterError() {
      usageMeterErrors.inc();
    },
    countEntitlementError() {
      entitlementErrors.inc();
    },
    countBillingOrder(kind, result) {
      billingOrders.inc({ kind, result });
    },
    countBillingWebhook(result) {
      billingWebhooks.inc({ result });
    },
    countBillingCheck(result) {
      billingChecks.inc({ result });
    },
    countBillingNotice(kind, result) {
      billingNotices.inc({ kind, result });
    },
    countBillingNoticeRun(result) {
      billingNoticeRuns.inc({ result });
    },
    countScheduleToolCall(tool, result) {
      scheduleToolCalls.inc({ tool, result });
    },
    countScheduleToolTurn(result) {
      scheduleToolTurns.inc({ result });
    },
    observeScheduleToolRounds(rounds) {
      scheduleToolRounds.observe(rounds);
    },
    countWebhookRequest(channel, result) {
      webhookRequests.inc({ channel, result });
    },
    countChannelInbound(channel, result) {
      channelInbound.inc({ channel, result });
    },
    countChannelStatus(channel, status) {
      channelStatus.inc({ channel, status });
    },
    observeChannelSend({ channel, result, durationSeconds }) {
      channelSend.inc({ channel, result });
      channelSendDuration.observe({ channel }, durationSeconds);
    },
    countChannelConnection(action, result) {
      channelConnections.inc({ action, result });
    },
    countChannelStateTransition(to) {
      channelStateTransitions.inc({ to });
    },
    countChannelCredentialError(reason) {
      channelCredentialErrors.inc({ reason });
    },
    countQueueJob(queue, result) {
      queueJobs.inc({ queue, result });
    },
    countRateLimitRejected(profile) {
      rateLimitRejected.inc({ profile });
    },
    countRateLimitStoreError() {
      rateLimitStoreErrors.inc();
    },
    countAuthLogin(kind, result) {
      authLogins.inc({ kind, result });
    },
    countAuthRefresh(result) {
      authRefresh.inc({ result });
    },
    countAuthTokenRejection(reason) {
      authTokenRejections.inc({ reason });
    },
    countAuthLogout(scope) {
      authLogouts.inc({ scope });
    },
    countVerificationEmail(result) {
      verificationEmails.inc({ result });
    },
    countVerificationAttempt(result) {
      verificationAttempts.inc({ result });
    },
    countPasswordResetRequest(result) {
      passwordResetRequests.inc({ result });
    },
    countPasswordResetAttempt(result) {
      passwordResetAttempts.inc({ result });
    },
    countPasswordResetEmail(kind, result) {
      passwordResetEmails.inc({ kind, result });
    },
    countAccountsPurged(count) {
      if (count > 0) accountsPurged.inc(count);
    },
    countAccountPurgeRun(result) {
      accountPurgeRuns.inc({ result });
    },
    countAuthzDenial(permission) {
      authzDenials.inc({ permission });
    },
    countMembershipAdminAction(action) {
      membershipAdminActions.inc({ action });
    },
    countCompanyPersonaUpdate(action) {
      companyPersonaUpdates.inc({ action });
    },
    countCompanyOnboardingAction(action) {
      companyOnboardingActions.inc({ action });
    },
    countCompanyInvitation(action, result) {
      companyInvitations.inc({ action, result });
    },
    countCompanyInvitationEmail(result) {
      companyInvitationEmails.inc({ result });
    },
    bindPool(source) {
      poolSource = source;
    },
    bindQueue(queue, source) {
      queueSources.set(queue, source);
    },
    observeQueueJob(queue, kind, { durationSeconds, waitSeconds }) {
      queueJobDuration.observe({ queue, kind }, durationSeconds);
      if (waitSeconds !== undefined) queueJobWait.observe({ queue, kind }, waitSeconds);
    },
    countProcessFatalError(kind) {
      processFatalErrors.inc({ kind });
    },
  };
}
