import type { FastifyBaseLogger } from 'fastify';
import { type Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { describeError } from '../../application/channel/describe-error.js';
import {
  type InboundJob,
  type InboundJobHandler,
  type InboundJobQueue,
  inboundJobId,
  inboundJobSchema,
  NonRetryableJobError,
} from '../../application/ports/inbound-job-queue.js';
import { MessageSendError } from '../../application/ports/message-sender.js';
import { ExternalServiceError } from '../../shared/errors/index.js';
import {
  createRequestContext,
  runWithContext,
  setClientId,
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

export interface InboundQueueOptions {
  readonly redisUrl: string;
  readonly settings: QueueSettings;
  readonly logger: FastifyBaseLogger;
  readonly metrics?: { countQueueJob(queue: string, result: QueueJobResult): void };
  readonly prefix?: string;
  readonly enqueueTimeoutMs?: number;
  readonly workerCloseTimeoutMs?: number;
}

export interface InboundQueueHandle {
  /** Lado produtor: a única coisa que a aplicação e a apresentação enxergam. */
  readonly queue: InboundJobQueue;
  /** Liga o worker (concorrência 1, no mesmo processo). Chamar duas vezes não faz nada. */
  startWorker(handler: InboundJobHandler): void;
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
  };

  /** Roda um job dentro do contexto de requisição do webhook que o originou. */
  async function runJob(job: Job, handler: InboundJobHandler): Promise<'done' | 'discarded'> {
    const parsed = inboundJobSchema.safeParse(job.data);
    if (!parsed.success) {
      // Nunca loga o conteúdo do job nem os detalhes do Zod (podem citar valores).
      count('failed');
      logger.error({ jobName: job.name }, 'job da fila com formato inválido; descartado');
      throw new UnrecoverableError('job inválido');
    }
    const data = parsed.data;
    const attempts = job.opts.attempts ?? 1;
    const attempt = job.attemptsMade + 1;
    const finalAttempt = attempt >= attempts;

    return runWithContext(createRequestContext(data.requestId), async () => {
      setClientId(data.clientId);
      setOperation(`job ${INBOUND_QUEUE_NAME}/${data.kind}`);
      try {
        const outcome = await handler(data, { finalAttempt });
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
        // Relança o erro: o BullMQ só precisa do nome/mensagem para `failedReason`; o erro dos
        // serviços (ExternalServiceError, ConflictError...) nunca carrega dado do contato.
        throw error;
      }
    });
  }

  return {
    queue: producer,

    startWorker(handler) {
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
          // "parado" no Redis e volta a ser processado no próximo boot.
          const graceful = current.close();
          graceful.catch(() => undefined);
          try {
            await withTimeout(graceful, workerCloseTimeoutMs, 'encerramento do worker');
          } catch (error) {
            logger.warn(
              describeError(error),
              'worker não terminou no prazo; forçando o encerramento das conexões',
            );
          }
        }
        await queue.close().catch((err: unknown) => {
          logger.warn(describeError(err), 'falha ao fechar a fila');
        });
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
