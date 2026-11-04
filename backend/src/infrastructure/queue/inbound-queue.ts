import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { type Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { describeError } from '../../application/channel/describe-error.js';
import {
  channelJobSchema,
  type FlushJob,
  type FlushSchedule,
  flushKey,
  type InboundJob,
  type InboundJobFailureHandler,
  type InboundJobHandler,
  type InboundJobQueue,
  inboundJobId,
  NonRetryableJobError,
} from '../../application/ports/inbound-job-queue.js';
import { MessageSendError } from '../../application/ports/message-sender.js';
import { ExternalServiceError } from '../../shared/errors/index.js';
import {
  createRequestContext,
  runWithContext,
  setCompanyId,
  setOperation,
} from '../../shared/request-context/index.js';
import { Result } from '../../shared/types/index.js';
import { withTimeout } from '../../shared/utils/index.js';
import { describeRedisError } from '../cache/rate-limit-redis.js';
import { closeRedisClient } from '../cache/redis.client.js';
import type { QueueSettings } from '../config/index.js';
import type { QueueJobResult } from '../metrics/index.js';

/** Nome da fila de entrada do canal (sem `:`, que o BullMQ recusa). */
export const INBOUND_QUEUE_NAME = 'channel-inbound';
/** Prefixo das chaves do BullMQ no Redis. Os testes passam um prefixo único por teste. */
export const DEFAULT_QUEUE_PREFIX = 'soprei:queue';

/** Quanto esperar o Redis ao enfileirar; passou disso, o webhook responde 500 e a Meta retenta. */
const DEFAULT_ENQUEUE_TIMEOUT_MS = 5_000;
/** Quanto esperar o job ativo no encerramento antes de forçar (LLM 15 s + envio 10 s com folga). */
const DEFAULT_WORKER_CLOSE_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 5_000;
/** Prazo para fechar fila e worker quando a conexão com o Redis não está pronta. */
const DISCONNECTED_CLOSE_TIMEOUT_MS = 2_000;

export interface InboundQueueOptions {
  readonly redisUrl: string;
  readonly settings: QueueSettings;
  readonly logger: FastifyBaseLogger;
  readonly metrics?: { countQueueJob(queue: string, result: QueueJobResult): void };
  readonly prefix?: string;
  readonly enqueueTimeoutMs?: number;
  readonly workerCloseTimeoutMs?: number;
  /** Intervalo da checagem de jobs parados do BullMQ (padrão 30 s; os testes baixam). */
  readonly stalledIntervalMs?: number;
  /** Quantas vezes um job pode parar antes de falhar de vez (padrão do BullMQ: 1; os testes usam 0). */
  readonly maxStalledCount?: number;
}

/** Ganchos opcionais do worker. */
export interface WorkerHooks {
  /** Job que falhou de vez sem passar pelo handler (ex.: parado além do limite). */
  readonly onUnhandledFailure?: InboundJobFailureHandler;
}

export interface InboundQueueHandle {
  /** Lado produtor: a única coisa que a aplicação e a apresentação enxergam. */
  readonly queue: InboundJobQueue;
  /** Liga o worker (concorrência 1, no mesmo processo). Chamar duas vezes não faz nada. */
  startWorker(handler: InboundJobHandler, hooks?: WorkerHooks): void;
  /** Contagem de jobs por estado (diagnóstico e testes). */
  jobCounts(): Promise<Record<string, number>>;
  /**
   * Encerramento gracioso: o worker espera o job ativo terminar (até o limite, depois força) e só
   * então a fila e as conexões Redis fecham. Idempotente. Chame **antes** de fechar o Redis e o
   * banco que o job ativo usa.
   */
  close(): Promise<void>;
}

function retryStrategy(times: number): number {
  return Math.min(times * 200, 2_000);
}

/**
 * Fila de entrada do canal sobre o BullMQ e o Redis existente (spec 011, decisão 1). O `bullmq`
 * usa o `ioredis` do projeto (dependência opcional dele, não uma cópia própria). As conexões são
 * **próprias**, separadas do singleton do resto do sistema:
 *
 * - produtor: `maxRetriesPerRequest: 1` e fila offline desligada, para Redis fora falhar rápido
 *   (o webhook responde 500) em vez de segurar a requisição;
 * - worker: `maxRetriesPerRequest: null`, exigência do BullMQ para a conexão bloqueante.
 *
 * Privacidade: o job guarda o texto do contato e o `contactRef` até concluir e pelo tempo de
 * `QUEUE_KEEP_*`. Erros do BullMQ/ioredis nunca são logados inteiros (o ioredis anexa
 * `command.args`): só campos controlados.
 */
export function createInboundQueue(options: InboundQueueOptions): InboundQueueHandle {
  const { redisUrl, settings, logger, metrics } = options;
  const prefix = options.prefix ?? DEFAULT_QUEUE_PREFIX;
  const enqueueTimeoutMs = options.enqueueTimeoutMs ?? DEFAULT_ENQUEUE_TIMEOUT_MS;
  const workerCloseTimeoutMs = options.workerCloseTimeoutMs ?? DEFAULT_WORKER_CLOSE_TIMEOUT_MS;

  const producerRedis = new Redis(redisUrl, {
    connectTimeout: CONNECT_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy,
  });
  producerRedis.on('error', (err: Error) => {
    logger.error(describeRedisError(err), 'erro na conexão Redis do produtor da fila');
  });
  const queue = new Queue(INBOUND_QUEUE_NAME, { connection: producerRedis, prefix });
  queue.on('error', (err: Error) => {
    logger.error(describeRedisError(err), 'erro na fila de entrada');
  });

  let workerRedis: Redis | undefined;
  let worker: Worker | undefined;
  let closing: Promise<void> | undefined;
  /** Ids de jobs cuja falha já foi tratada (e contada) dentro do handler: o evento `failed` os ignora. */
  const handledFailures = new Set<string>();

  const count = (result: QueueJobResult): void => {
    try {
      metrics?.countQueueJob(INBOUND_QUEUE_NAME, result);
    } catch (err) {
      logger.warn(describeError(err), 'falha ao registrar métrica da fila');
    }
  };

  const producer: InboundJobQueue = {
    async enqueue(job: InboundJob) {
      try {
        await withTimeout(
          queue.add(job.kind, job, {
            // Dedupe de reentregas do canal; a idempotência definitiva é a do banco (`externalId`).
            jobId: inboundJobId(job),
            attempts: settings.attempts,
            backoff: { type: 'exponential', delay: settings.backoffMs },
            removeOnComplete: { age: settings.keepCompletedSeconds },
            removeOnFail: { age: settings.keepFailedSeconds },
          }),
          enqueueTimeoutMs,
          'fila de entrada',
        );
        return Result.ok(undefined);
      } catch (error) {
        // Sem `cause`: o erro do ioredis carrega os argumentos do comando (o job, com o texto).
        return Result.err(
          new ExternalServiceError('Falha ao enfileirar a mensagem', {
            context: { queue: INBOUND_QUEUE_NAME, ...describeRedisError(error) },
          }),
        );
      }
    },

    /**
     * Um `flush` por `(companyId, contactRef)`, pela deduplicação do BullMQ (id = `flushKey`, que
     * inclui o `companyId`), com `keepLastIfActive`: se o `flush` do contato está rodando agora, o
     * próximo é guardado em Redis e criado, de forma atômica, quando ele terminar. `slide` usa
     * `replace`: o `flush` que ainda espera (job atrasado) é removido e um novo, com a espera
     * inteira, o substitui (janela deslizante). O `jobId` é único por agendamento: com um `jobId`
     * fixo o BullMQ trata o novo como duplicata antes de olhar a deduplicação e o `replace` nunca
     * rodaria. O job conclui sem retenção (`removeOnComplete: true`): não deixa o `contactRef` no Redis.
     */
    async scheduleFlush(job: FlushJob, schedule: FlushSchedule) {
      const key = flushKey(job);
      try {
        await withTimeout(
          queue.add(job.kind, job, {
            jobId: `${key}_${randomUUID()}`,
            delay: schedule.delayMs,
            deduplication:
              schedule.mode === 'slide'
                ? { id: key, replace: true, keepLastIfActive: true }
                : { id: key, keepLastIfActive: true },
            attempts: settings.attempts,
            backoff: { type: 'exponential', delay: settings.backoffMs },
            removeOnComplete: true,
            removeOnFail: { age: settings.keepFailedSeconds },
          }),
          enqueueTimeoutMs,
          'fila de entrada',
        );
        return Result.ok(undefined);
      } catch (error) {
        return Result.err(
          new ExternalServiceError('Falha ao agendar a resposta ao contato', {
            context: { queue: INBOUND_QUEUE_NAME, ...describeRedisError(error) },
          }),
        );
      }
    },
  };

  /** A falha deste job já foi contada e logada aqui; o evento `failed` do worker não repete. */
  const markHandled = (job: Job): void => {
    if (job.id !== undefined) handledFailures.add(job.id);
  };

  /** Roda um job dentro do contexto de requisição do webhook que o originou. */
  async function runJob(job: Job, handler: InboundJobHandler): Promise<'done' | 'discarded'> {
    const parsed = channelJobSchema.safeParse(job.data);
    if (!parsed.success) {
      // Nunca loga o conteúdo do job nem os detalhes do Zod (podem citar valores).
      count('failed');
      markHandled(job);
      logger.error({ jobName: job.name }, 'job da fila com formato inválido; descartado');
      throw new UnrecoverableError('job inválido');
    }
    const data = parsed.data;
    const attempts = job.opts.attempts ?? 1;
    const attempt = job.attemptsMade + 1;
    const finalAttempt = attempt >= attempts;

    return runWithContext(createRequestContext(data.requestId), async () => {
      setCompanyId(data.companyId);
      setOperation(`job ${INBOUND_QUEUE_NAME}/${data.kind}`);
      try {
        const outcome = await handler(data, { attempt, finalAttempt });
        count(outcome === 'discarded' ? 'discarded' : 'completed');
        return outcome;
      } catch (error) {
        const fields = {
          jobKind: data.kind,
          attempt,
          attempts,
          ...describeError(error),
          ...(error instanceof MessageSendError
            ? {
                httpStatus: error.httpStatus,
                providerCode: error.providerCode,
                retryable: error.retryable,
              }
            : {}),
        };
        if (error instanceof NonRetryableJobError) {
          count('failed');
          markHandled(job);
          logger.error(fields, 'job falhou sem retentativa');
          throw new UnrecoverableError('job não retentável');
        }
        if (finalAttempt) {
          count('failed');
          logger.error(fields, 'job esgotou as tentativas');
        } else {
          count('retried');
          logger.warn(fields, 'job falhou; será retentado com backoff');
        }
        markHandled(job);
        // Relança o erro: o BullMQ só precisa do nome/mensagem para `failedReason`; o erro dos
        // serviços (ExternalServiceError, ConflictError...) nunca carrega dado do contato.
        throw error;
      }
    });
  }

  return {
    queue: producer,

    startWorker(handler, hooks = {}) {
      if (worker !== undefined) return;
      const connection = new Redis(redisUrl, {
        connectTimeout: CONNECT_TIMEOUT_MS,
        // Exigência do BullMQ para a conexão bloqueante do worker.
        maxRetriesPerRequest: null,
        retryStrategy,
      });
      connection.on('error', (err: Error) => {
        logger.error(describeRedisError(err), 'erro na conexão Redis do worker da fila');
      });
      workerRedis = connection;
      worker = new Worker(INBOUND_QUEUE_NAME, (job: Job) => runJob(job, handler), {
        connection,
        prefix,
        // Concorrência 1 preserva a ordem de chegada (decisão 2 da spec 011).
        concurrency: 1,
        ...(options.stalledIntervalMs === undefined
          ? {}
          : { stalledInterval: options.stalledIntervalMs }),
        ...(options.maxStalledCount === undefined
          ? {}
          : { maxStalledCount: options.maxStalledCount }),
      });
      // Falha que NÃO passou pelo handler (ex.: job parado além do limite depois de uma queda do
      // processo): nunca em silêncio. Log só com campos seguros (nada de id do job, que carrega o
      // wamid, nem o erro inteiro) e a métrica; depois tenta, sem duplicar, não deixar o contato mudo.
      worker.on('failed', (job: Job | undefined, err: Error) => {
        if (job?.id !== undefined && handledFailures.delete(job.id)) return;
        count('failed');
        logger.error(
          {
            jobKind: job?.name,
            attemptsMade: job?.attemptsMade,
            ...describeError(err),
          },
          'job falhou sem passar pelo handler',
        );
        const parsed = channelJobSchema.safeParse(job?.data);
        const onFailure = hooks.onUnhandledFailure;
        if (!parsed.success || onFailure === undefined) return;
        runWithContext(createRequestContext(parsed.data.requestId), () => {
          setCompanyId(parsed.data.companyId);
          onFailure(parsed.data).catch((hookError: unknown) => {
            logger.error(describeError(hookError), 'falha ao tratar o job que falhou sem handler');
          });
        });
      });
      // Job parado (processo caiu ou travou com ele ativo): o BullMQ o devolve à fila e ele roda de
      // novo; conta como retentativa. O id do job carrega o wamid: não vai a log.
      worker.on('stalled', () => {
        count('retried');
        logger.warn({ queue: INBOUND_QUEUE_NAME }, 'job parado; será reprocessado');
      });
      worker.on('error', (err: Error) => {
        logger.error(describeRedisError(err), 'erro no worker da fila de entrada');
      });
      logger.info({ queue: INBOUND_QUEUE_NAME, concurrency: 1 }, 'worker da fila iniciado');
    },

    async jobCounts() {
      return queue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed');
    },

    close() {
      closing ??= (async () => {
        const current = worker;
        if (current !== undefined) {
          // Espera o job ativo terminar (o BullMQ memoriza o fechamento: um segundo `close(true)` não
          // adiantaria). Passou do limite, segue para fechar fila e conexões: o job interrompido fica
          // "parado" no Redis e volta a ser processado no próximo boot. Sem conexão pronta não há job
          // ativo para esperar (ex.: Redis fora no boot): o prazo é curto.
          const connected = workerRedis?.status === 'ready';
          const graceful = current.close(!connected);
          graceful.catch(() => undefined);
          const waitMs = connected
            ? workerCloseTimeoutMs
            : Math.min(workerCloseTimeoutMs, DISCONNECTED_CLOSE_TIMEOUT_MS);
          try {
            await withTimeout(graceful, waitMs, 'encerramento do worker');
          } catch (error) {
            logger.warn(
              describeError(error),
              'worker não terminou no prazo; forçando o encerramento das conexões',
            );
          }
        }
        // `queue.close()` espera a conexão ficar pronta: com o Redis fora ficaria pendurado. As
        // conexões são fechadas à força logo depois, o que também solta qualquer espera do BullMQ.
        const queueClosed = queue.close().catch((err: unknown) => {
          logger.warn(describeError(err), 'falha ao fechar a fila');
        });
        try {
          await withTimeout(queueClosed, DISCONNECTED_CLOSE_TIMEOUT_MS, 'fechamento da fila');
        } catch (error) {
          logger.warn(describeError(error), 'a fila não fechou no prazo; fechando as conexões');
        }
        // As conexões são nossas (o BullMQ não fecha instância recebida): só agora, depois do worker.
        await Promise.allSettled([
          closeRedisClient(producerRedis),
          workerRedis === undefined ? undefined : closeRedisClient(workerRedis),
        ]);
      })();
      return closing;
    },
  };
}
