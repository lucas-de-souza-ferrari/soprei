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
    bindPool(source) {
      poolSource = source;
    },
  };
}
