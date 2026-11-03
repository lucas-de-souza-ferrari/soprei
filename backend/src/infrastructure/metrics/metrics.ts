import type { AuditAction, Permission } from '../../domain/index.js';
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
  | 'client_unavailable'
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
export type ChannelCredentialErrorReason = 'malformed' | 'unknown_key' | 'tampered';

export interface ChannelSendSample {
  /** Canal (`whatsapp`): conjunto pequeno e fixo, nunca dado do usuário. */
  readonly channel: string;
  readonly result: ChannelSendResult;
  readonly durationSeconds: number;
}

/** Resultado de um job da fila: `completed`, `retried`, `failed` ou `discarded`. */
export type QueueJobResult = 'completed' | 'retried' | 'failed' | 'discarded';

/** Status de entrega informado pelo canal (`other` agrupa qualquer valor desconhecido). */
export type ChannelStatusEvent = 'sent' | 'delivered' | 'read' | 'played' | 'failed' | 'other';

/** Resultado de um login (spec 007): `ok`, `invalid` (qualquer credencial recusada) ou `locked`. */
export type AuthLoginResult = 'ok' | 'invalid' | 'locked';
export type AuthLoginKind = 'user' | 'platform';
export type AuthRefreshResult = 'ok' | 'invalid' | 'reuse' | 'unavailable';
export type AuthTokenRejectionReason =
  'missing' | 'malformed' | 'invalid' | 'expired' | 'revoked' | 'unavailable';
export type AuthLogoutScope = 'session' | 'all';
/** Envio do código de confirmação de e-mail em segundo plano (spec 017). */
export type VerificationEmailResult = 'sent' | 'failed';

export interface DbQuerySample {
  readonly model: string;
  readonly operation: string;
  readonly durationSeconds: number;
}

/**
 * Métricas do processo. Há um `Registry` dedicado (não o global) para não vazar estado entre
 * testes; as próximas specs (rate limit, cache...) registram as suas métricas nele.
 *
 * Cardinalidade controlada: nenhum label com `clientId`, `userId`, id de recurso ou URL crua.
 */
export interface Metrics {
  readonly registry: Registry;
  /** Formato de texto do Prometheus. */
  readonly contentType: string;
  render(): Promise<string>;
  observeHttpRequest(sample: HttpRequestSample): void;
  observeDbQuery(sample: DbQuerySample): void;
  /** Uma chamada ao LLM terminou (spec 010). Sem `clientId` em label. */
  observeLlmRequest(sample: LlmRequestSample): void;
  /** Tokens de uma chamada ao LLM que respondeu (spec 014). Sem `clientId` nem texto em label. */
  observeLlmTokens(sample: LlmTokensSample): void;
  /** O contato recebeu o texto padrão de falha em vez de uma resposta do modelo. */
  countAttendanceFallback(): void;
  /** Uma resposta de lote terminou (spec 013). Sem `clientId`, telefone nem texto em label. */
  observeAttendanceBatch(sample: BatchSample): void;
  /** Um turno saiu com a resposta do turno anterior ainda sem `sentAt` (spec 013). Sem labels. */
  countUnsentReply(): void;
  /** Uma requisição ao webhook do canal terminou (spec 011). Sem telefone nem texto em label. */
  countWebhookRequest(channel: string, result: WebhookRequestResult): void;
  /** O destino de uma mensagem de entrada do canal. */
  countChannelInbound(channel: string, result: ChannelInboundResult): void;
  /** Um evento de status de entrega do canal (só contagem). */
  countChannelStatus(channel: string, status: ChannelStatusEvent): void;
  /** Um envio de mensagem ao canal terminou. */
  observeChannelSend(sample: ChannelSendSample): void;
  /** Uma operação de conexão do canal terminou (spec 015). Sem `clientId`, número, WABA nem token. */
  countChannelConnection(action: ChannelConnectionAction, result: ChannelConnectionResult): void;
  /** A conexão do cliente passou a `TOKEN_INVALID` (spec 015). */
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
  /** O hook `requirePermission` negou uma permissão (spec 008). `permission` é do conjunto fixo, nunca id. */
  countAuthzDenial(permission: Permission): void;
  /** Uma operação de gestão de usuários foi confirmada (spec 008). `action` é o `AuditAction`. */
  countUserAdminAction(action: AuditAction): void;
  /** Liga os gauges do pool à fonte; eles são lidos só no momento da coleta (sem timers). */
  bindPool(source: () => PoolSnapshot): void;
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
    help: 'Logins por tipo de identidade (user, platform) e resultado (ok, invalid, locked)',
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

  const verificationEmails = new Counter({
    name: 'account_verification_sends_total',
    help: 'Envios do código de confirmação da conta por resultado (sent, failed)',
    labelNames: ['result'] as const,
    registers: [registry],
  });

  const authzDenials = new Counter({
    name: 'authz_denials_total',
    help: 'Negações de permissão pelo hook requirePermission, por permissão (conjunto fixo)',
    labelNames: ['permission'] as const,
    registers: [registry],
  });
  const userAdminActions = new Counter({
    name: 'user_admin_actions_total',
    help: 'Operações de gestão de usuários confirmadas, por ação de auditoria (conjunto fixo)',
    labelNames: ['action'] as const,
    registers: [registry],
  });

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
    render: () => registry.metrics(),
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
    countAuthzDenial(permission) {
      authzDenials.inc({ permission });
    },
    countUserAdminAction(action) {
      userAdminActions.inc({ action });
    },
    bindPool(source) {
      poolSource = source;
    },
  };
}
