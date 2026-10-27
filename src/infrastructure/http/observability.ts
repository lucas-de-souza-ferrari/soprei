import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { METRICS_ROUTE } from '../../presentation/metrics.controller.js';
import { routePattern } from '../../presentation/route-pattern.js';
import {
  createRequestContext,
  type RequestContext,
  runWithContext,
  setOperation,
} from '../../shared/request-context/index.js';
import type { Metrics } from '../metrics/index.js';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;
export const REQUEST_ID_HEADER = 'x-request-id';

/** Status registrado quando o cliente desconecta antes da resposta (convenção do nginx). */
const CLIENT_CLOSED_STATUS = 499;

/** Rotas de infraestrutura: o log de requisição bem-sucedida delas sai em `debug`. */
const QUIET_ROUTES: ReadonlySet<string> = new Set(['/health', '/health/ready', METRICS_ROUTE]);

/**
 * Reaproveita `x-request-id` quando casa com `^[A-Za-z0-9._-]{8,128}$`; senão gera um UUID.
 * Cabeçalho repetido (o Node junta com vírgula e espaço) ou não string é inválido.
 */
export function generateRequestId(req: Pick<IncomingMessage, 'headers'>): string {
  const incoming: unknown = req.headers[REQUEST_ID_HEADER];
  return typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
    ? incoming
    : randomUUID();
}

export interface ObservabilityOptions {
  /** Sem isto não há métricas HTTP (os logs e o contexto continuam). */
  readonly metrics?: Metrics | undefined;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function levelFor(route: string, statusCode: number): LogLevel {
  if (statusCode >= 500) return 'error';
  if (statusCode >= 400) return 'warn';
  return QUIET_ROUTES.has(route) ? 'debug' : 'info';
}

/**
 * Liga à instância (chame antes de registrar as rotas): contexto por requisição, cabeçalho
 * `x-request-id`, log de requisição próprio (o padrão do Fastify fica desligado) e métricas
 * HTTP. O fim da requisição é registrado uma única vez, também quando o cliente desconecta.
 */
export function registerObservability(
  app: FastifyInstance,
  { metrics }: ObservabilityOptions = {},
): void {
  const startedAt = new WeakMap<FastifyRequest, number>();
  const contexts = new WeakMap<FastifyRequest, RequestContext>();
  const finished = new WeakSet<FastifyRequest>();

  /**
   * Fim da requisição, uma única vez. Roda DENTRO do contexto guardado da requisição: o
   * `onRequestAbort` vem de um evento `close` do socket, que o Node entrega fora do
   * `als.run` aberto no `onRequest` (verificado em teste: o log de aborto saía sem
   * `operation`/`clientId`). Os hooks normais (`onResponse`) já chegam com o contexto, mas
   * reentrar aqui deixa os dois caminhos iguais.
   */
  function recordEnd(request: FastifyRequest, statusCode: number): void {
    if (finished.has(request)) return;
    finished.add(request);
    const context = contexts.get(request);
    if (context === undefined) {
      logAndCount(request, statusCode);
    } else {
      runWithContext(context, () => {
        logAndCount(request, statusCode);
      });
    }
  }

  function logAndCount(request: FastifyRequest, statusCode: number): void {
    const route = routePattern(request);
    const durationMs = performance.now() - (startedAt.get(request) ?? performance.now());
    request.log[levelFor(route, statusCode)](
      {
        method: request.method,
        route,
        statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      },
      'requisição concluída',
    );

    if (metrics === undefined || route === METRICS_ROUTE) return;
    try {
      metrics.observeHttpRequest({
        method: request.method,
        route,
        statusCode,
        durationSeconds: durationMs / 1000,
      });
    } catch (err) {
      request.log.warn({ err }, 'falha ao registrar métrica HTTP');
    }
  }

  app.addHook('onRequest', (request, _reply, done) => {
    startedAt.set(request, performance.now());
    const context = createRequestContext(request.id);
    contexts.set(request, context);
    runWithContext(context, () => {
      setOperation(`${request.method} ${routePattern(request)}`);
      done();
    });
  });

  app.addHook('onSend', (request, reply, payload, done) => {
    void reply.header(REQUEST_ID_HEADER, request.id);
    done(null, payload);
  });

  app.addHook('onResponse', (request, reply, done) => {
    recordEnd(request, reply.statusCode);
    done();
  });

  app.addHook('onRequestAbort', (request, done) => {
    recordEnd(request, CLIENT_CLOSED_STATUS);
    done();
  });
}
