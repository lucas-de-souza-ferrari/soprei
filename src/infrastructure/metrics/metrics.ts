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

/** Resultado de uma chamada ao LLM: `ok`, `error` (falha ou resposta inutilizável) ou `timeout`. */
export type LlmRequestResult = 'ok' | 'error' | 'timeout';

export interface LlmRequestSample {
  /** Nome do provedor (`mock`...): conjunto pequeno e fixo, nunca dado do usuário. */
  readonly provider: string;
  readonly result: LlmRequestResult;
  readonly durationSeconds: number;
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
  /** O contato recebeu o texto padrão de falha em vez de uma resposta do modelo. */
  countAttendanceFallback(): void;
  /** Uma requisição ao webhook do canal terminou (spec 011). Sem telefone nem texto em label. */
  countWebhookRequest(channel: string, result: WebhookRequestResult): void;
  /** O destino de uma mensagem de entrada do canal. */
  countChannelInbound(channel: string, result: ChannelInboundResult): void;
  /** Um evento de status de entrega do canal (só contagem). */
  countChannelStatus(channel: string, status: ChannelStatusEvent): void;
  /** Um envio de mensagem ao canal terminou. */
  observeChannelSend(sample: ChannelSendSample): void;
  /** Um job da fila terminou (ou foi reagendado). `queue` é o nome fixo da fila. */
  countQueueJob(queue: string, result: QueueJobResult): void;
  /** Uma requisição foi recusada com 429 (spec 005). `profile` é um dos perfis fixos, nunca IP. */
  countRateLimitRejected(profile: string): void;
  /** O store (Redis) do rate limit falhou e a requisição passou em fail-open (spec 005). */
  countRateLimitStoreError(): void;
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
    help: 'Total de chamadas ao LLM, por provedor e resultado (ok, error, timeout)',
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
  const attendanceFallbacks = new Counter({
    name: 'attendance_fallbacks_total',
    help: 'Total de respostas de fallback (texto padrão) enviadas por falha do LLM',
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
  const queueJobs = new Counter({
    name: 'queue_jobs_total',
    help: 'Jobs da fila por nome da fila e resultado (completed, retried, failed, discarded)',
    labelNames: ['queue', 'result'] as const,
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
    countAttendanceFallback() {
      attendanceFallbacks.inc();
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
    countQueueJob(queue, result) {
      queueJobs.inc({ queue, result });
    },
    countRateLimitRejected(profile) {
      rateLimitRejected.inc({ profile });
    },
    countRateLimitStoreError() {
      rateLimitStoreErrors.inc();
    },
    bindPool(source) {
      poolSource = source;
    },
  };
}
