import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, afterEach, before, describe, it } from 'node:test';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import {
  type InboundJob,
  type InboundJobContext,
  type InboundJobHandler,
  inboundJobId,
  NonRetryableJobError,
} from '../../application/ports/inbound-job-queue.js';
import { ExternalServiceError } from '../../shared/errors/index.js';
import { getContext } from '../../shared/request-context/index.js';
import { getClosedPort, withPort } from '../../test-support/closed-port.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { keepEventLoopAlive } from '../../test-support/keep-alive.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { TestKeyspace } from '../../test-support/test-keyspace.js';
import { ToggleProxy } from '../../test-support/toggle-proxy.js';
import { createMetrics } from '../metrics/index.js';
import {
  createInboundQueue,
  INBOUND_QUEUE_NAME,
  type InboundQueueHandle,
  type InboundQueueOptions,
} from './inbound-queue.js';

// Falha aqui (antes de abrir qualquer conexão) se o ambiente não for o de testes (Redis /15).
const config = loadIntegrationConfig();

const SECRET_TEXT = 'texto-secreto-da-fila-5d2';
const CONTACT = '5511987654321';
const SETTINGS = { attempts: 3, backoffMs: 30, keepCompletedSeconds: 600, keepFailedSeconds: 600 };

let cleanupRedis: Redis;
const keyspace = new TestKeyspace();
const open: InboundQueueHandle[] = [];
const rawQueues: Queue[] = [];
const rawConnections: Redis[] = [];

before(() => {
  cleanupRedis = new Redis(config.REDIS_URL);
});

afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
  for (const queue of rawQueues.splice(0)) await queue.close();
  for (const connection of rawConnections.splice(0)) connection.disconnect();
  await keyspace.cleanup(cleanupRedis);
});

after(() => {
  cleanupRedis.disconnect();
});

/** `soprei:test:<uuid>:bull` (sem `:` final): o BullMQ monta `<prefixo>:<fila>:<chave>`. */
function uniquePrefix(): string {
  return keyspace.scopedPrefix('bull').slice(0, -1);
}

interface Harness {
  readonly handle: InboundQueueHandle;
  readonly metrics: ReturnType<typeof createMetrics>;
  readonly logs: ReturnType<typeof captureLogs>;
  readonly prefix: string;
}

function setup(overrides: Partial<InboundQueueOptions> = {}): Harness {
  const metrics = createMetrics();
  const logs = captureLogs();
  const prefix = overrides.prefix ?? uniquePrefix();
  const handle = createInboundQueue({
    redisUrl: config.REDIS_URL,
    settings: SETTINGS,
    logger: logs.logger,
    metrics,
    prefix,
    ...overrides,
  });
  open.push(handle);
  return { handle, metrics, logs, prefix };
}

const textJob = (overrides: Partial<Extract<InboundJob, { kind: 'text' }>> = {}): InboundJob => ({
  kind: 'text',
  clientId: randomUUID(),
  phoneNumberId: '106540352242922',
  contactRef: CONTACT,
  text: SECRET_TEXT,
  externalId: `wamid.${randomUUID()}`,
  requestId: `req-${randomUUID()}`,
  ...overrides,
});

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(15);
  }
  throw new Error(`tempo esgotado esperando: ${label}`);
}

async function metricValue(metrics: Harness['metrics'], result: string): Promise<number> {
  const body = await metrics.render();
  const match = new RegExp(
    `queue_jobs_total\\{queue="${INBOUND_QUEUE_NAME}",result="${result}"\\} (\\d+)`,
  ).exec(body);
  return match === null ? 0 : Number(match[1]);
}

/** Handler que registra cada chamada e devolve o resultado de `behavior`. */
function recordingHandler(
  behavior: (
    job: InboundJob,
    context: InboundJobContext,
    call: number,
  ) => Promise<'done' | 'discarded'> | 'done' | 'discarded' = () => 'done',
): { handler: InboundJobHandler; calls: { job: InboundJob; context: InboundJobContext }[] } {
  const calls: { job: InboundJob; context: InboundJobContext }[] = [];
  return {
    calls,
    handler: async (job, context) => {
      calls.push({ job, context });
      return await behavior(job, context, calls.length);
    },
  };
}

describe('fila de entrada (BullMQ sobre o Redis /15)', () => {
  it('enfileira, o worker processa no contexto do requestId e do clientId do job, e conta completed', async () => {
    const { handle, metrics, logs } = setup();
    const seen: { requestId?: string; clientId?: string }[] = [];
    const { handler, calls } = recordingHandler(() => {
      const context = getContext();
      seen.push({ requestId: context?.requestId, clientId: context?.clientId });
      logs.logger.info('dentro do handler');
      return 'done';
    });
    handle.startWorker(handler);

    const job = textJob();
    const result = await handle.queue.enqueue(job);
    assert.ok(result.ok);
    await waitFor(() => calls.length === 1, 'job processado');

    assert.deepEqual(calls[0]?.job, job);
    assert.equal(calls[0].context.finalAttempt, false);
    assert.deepEqual(seen, [{ requestId: job.requestId, clientId: job.clientId }]);
    const line = logs.lines().find((entry) => entry.msg === 'dentro do handler');
    assert.equal(line?.requestId, job.requestId);
    assert.equal(line.clientId, job.clientId);
    await waitFor(async () => (await metricValue(metrics, 'completed')) === 1, 'métrica completed');
  });

  it('o job guarda as opções da config: tentativas, backoff exponencial e retenção; jobId sem ":"', async () => {
    const { handle, prefix } = setup();
    const job = textJob({ externalId: 'wamid:com:dois-pontos%e==' });
    assert.ok((await handle.queue.enqueue(job)).ok);

    const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
    rawConnections.push(connection);
    const raw = new Queue(INBOUND_QUEUE_NAME, { connection, prefix });
    rawQueues.push(raw);
    const jobId = inboundJobId(job);
    assert.ok(!jobId.includes(':'));
    const stored = await raw.getJob(jobId);
    assert.ok(stored !== undefined);
    assert.equal(stored.opts.attempts, SETTINGS.attempts);
    assert.deepEqual(stored.opts.backoff, { type: 'exponential', delay: SETTINGS.backoffMs });
    assert.deepEqual(stored.opts.removeOnComplete, { age: SETTINGS.keepCompletedSeconds });
    assert.deepEqual(stored.opts.removeOnFail, { age: SETTINGS.keepFailedSeconds });
    assert.equal(stored.name, 'text');
  });

  it('reentrega do mesmo evento (mesmo cliente e externalId) não gera segundo job; clientes diferentes não colidem', async () => {
    const { handle } = setup();
    const { handler, calls } = recordingHandler();
    const job = textJob();
    // Enfileira antes de ligar o worker: os três pedidos caem no mesmo job.
    assert.ok((await handle.queue.enqueue(job)).ok);
    assert.ok((await handle.queue.enqueue({ ...job, requestId: 'req-outra-entrega' })).ok);
    assert.ok((await handle.queue.enqueue(job)).ok);
    const other = textJob({ externalId: job.externalId });
    assert.ok((await handle.queue.enqueue(other)).ok);

    handle.startWorker(handler);
    await waitFor(() => calls.length >= 2, 'dois jobs');
    await sleep(150);
    assert.equal(calls.length, 2, 'um job por (cliente, externalId)');
    assert.deepEqual(
      new Set(calls.map((call) => call.job.clientId)),
      new Set([job.clientId, other.clientId]),
    );
  });

  it('falha transitória é retentada com backoff até dar certo; só a última tentativa é finalAttempt', async () => {
    const { handle, metrics } = setup();
    const { handler, calls } = recordingHandler((_job, _context, call) => {
      if (call < 3) throw new ExternalServiceError('falha transitória');
      return 'done';
    });
    handle.startWorker(handler);
    assert.ok((await handle.queue.enqueue(textJob())).ok);

    await waitFor(() => calls.length === 3, 'três tentativas');
    assert.deepEqual(
      calls.map((call) => call.context.finalAttempt),
      [false, false, true],
    );
    await waitFor(async () => (await metricValue(metrics, 'completed')) === 1, 'completed');
    assert.equal(await metricValue(metrics, 'retried'), 2);
    assert.equal(await metricValue(metrics, 'failed'), 0);
  });

  it('esgota as tentativas: failed, e a última chamada vem com finalAttempt', async () => {
    const { handle, metrics } = setup();
    const { handler, calls } = recordingHandler(() => {
      throw new ExternalServiceError('sempre falha');
    });
    handle.startWorker(handler);
    assert.ok((await handle.queue.enqueue(textJob())).ok);

    await waitFor(async () => (await metricValue(metrics, 'failed')) === 1, 'failed');
    await sleep(150);
    assert.equal(calls.length, SETTINGS.attempts, 'não passa do limite de tentativas');
    assert.equal(calls.at(-1)?.context.finalAttempt, true);
    assert.equal(await metricValue(metrics, 'retried'), SETTINGS.attempts - 1);
    const counts = await handle.jobCounts();
    assert.equal(counts.failed, 1);
  });

  it('NonRetryableJobError não é retentado', async () => {
    const { handle, metrics } = setup();
    const { handler, calls } = recordingHandler(() => {
      throw new NonRetryableJobError('permanente');
    });
    handle.startWorker(handler);
    assert.ok((await handle.queue.enqueue(textJob())).ok);

    await waitFor(async () => (await metricValue(metrics, 'failed')) === 1, 'failed');
    await sleep(200);
    assert.equal(calls.length, 1);
    assert.equal(await metricValue(metrics, 'retried'), 0);
  });

  it('descarte de propósito conta discarded e conclui o job', async () => {
    const { handle, metrics } = setup();
    const { handler } = recordingHandler(() => 'discarded');
    handle.startWorker(handler);
    assert.ok((await handle.queue.enqueue(textJob())).ok);
    await waitFor(async () => (await metricValue(metrics, 'discarded')) === 1, 'discarded');
    assert.equal(await metricValue(metrics, 'completed'), 0);
  });

  it('job com formato inválido no Redis é descartado sem chamar o handler nem logar o conteúdo', async () => {
    const { handle, metrics, logs, prefix } = setup();
    const { handler, calls } = recordingHandler();
    handle.startWorker(handler);

    const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
    rawConnections.push(connection);
    const raw = new Queue(INBOUND_QUEUE_NAME, { connection, prefix });
    rawQueues.push(raw);
    await raw.add('text', {
      kind: 'text',
      clientId: 'nao-e-uuid',
      text: SECRET_TEXT,
      contactRef: CONTACT,
    });

    await waitFor(async () => (await metricValue(metrics, 'failed')) === 1, 'failed');
    assert.equal(calls.length, 0);
    assert.ok(!logs.raw().includes(SECRET_TEXT));
    assert.ok(!logs.raw().includes(CONTACT));
  });

  it('concorrência 1: os jobs rodam um por vez, na ordem em que entraram', async () => {
    const { handle } = setup();
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const { handler, calls } = recordingHandler(async (job): Promise<'done'> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(40);
      order.push(job.externalId);
      active -= 1;
      return 'done';
    });
    const jobs = Array.from({ length: 4 }, (_, index) =>
      textJob({ externalId: `wamid.ordem-${String(index)}` }),
    );
    for (const job of jobs) assert.ok((await handle.queue.enqueue(job)).ok);
    handle.startWorker(handler);

    await waitFor(() => calls.length === 4 && active === 0, 'quatro jobs');
    assert.equal(maxActive, 1);
    assert.deepEqual(
      order,
      jobs.map((job) => job.externalId),
    );
  });

  it('encerramento gracioso: close() espera o job ativo terminar e depois nada mais é processado', async () => {
    const { handle } = setup();
    let finished = false;
    let started = false;
    const { handler, calls } = recordingHandler(async (): Promise<'done'> => {
      started = true;
      await sleep(400);
      finished = true;
      return 'done';
    });
    handle.startWorker(handler);
    assert.ok((await handle.queue.enqueue(textJob())).ok);
    await waitFor(() => started, 'job ativo');

    const closing = handle.close();
    assert.equal(finished, false, 'o job ainda estava rodando quando o close começou');
    await closing;
    assert.equal(finished, true, 'close() só terminou depois do job ativo');
    assert.equal(calls.length, 1);
    // close() é idempotente.
    await handle.close();
  });

  it('close() força o fechamento quando o job ativo passa do limite', async (t) => {
    const release = keepEventLoopAlive();
    t.after(release);
    const { handle, logs } = setup({ workerCloseTimeoutMs: 100 });
    let started = false;
    handle.startWorker(async (): Promise<'done'> => {
      started = true;
      await sleep(1_500);
      return 'done';
    });
    assert.ok((await handle.queue.enqueue(textJob())).ok);
    await waitFor(() => started, 'job ativo');
    const begin = Date.now();
    await handle.close();
    assert.ok(Date.now() - begin < 1_400, 'não esperou o job inteiro');
    assert.ok(logs.lines().some((line) => String(line.msg).includes('forçando')));
  });
});

describe('fila de entrada: Redis fora', () => {
  it('enfileirar com o Redis inalcançável devolve erro rápido, sem texto nem contato no erro ou no log', async (t) => {
    const release = keepEventLoopAlive();
    t.after(release);
    const { handle, logs } = setup({
      redisUrl: withPort(config.REDIS_URL, await getClosedPort()),
      enqueueTimeoutMs: 800,
    });
    const begin = Date.now();
    const result = await handle.queue.enqueue(textJob());
    assert.equal(result.ok, false);
    assert.ok(Date.now() - begin < 3_000);
    const dump = JSON.stringify({ message: result.error.message, context: result.error.context });
    assert.ok(!dump.includes(SECRET_TEXT));
    assert.ok(!dump.includes(CONTACT));
    await sleep(100);
    assert.ok(!logs.raw().includes(SECRET_TEXT));
    assert.ok(!logs.raw().includes(CONTACT));
  });

  it('o Redis cai depois de conectado: enqueue falha rápido; quando volta, enfileira de novo', async (t) => {
    const release = keepEventLoopAlive();
    t.after(release);
    const url = new URL(config.REDIS_URL);
    const proxy = new ToggleProxy(url.hostname, Number(url.port === '' ? 6379 : url.port));
    await proxy.start();
    t.after(() => proxy.stop());
    const { handle, logs } = setup({
      redisUrl: withPort(config.REDIS_URL, proxy.listeningPort),
      enqueueTimeoutMs: 1_000,
    });

    assert.ok((await handle.queue.enqueue(textJob())).ok, 'com o Redis no ar');

    await proxy.stop();
    const begin = Date.now();
    const down = await handle.queue.enqueue(textJob());
    assert.equal(down.ok, false);
    assert.ok(Date.now() - begin < 3_000, 'falha rápido, não segura a requisição');

    await proxy.start();
    await waitFor(async () => (await handle.queue.enqueue(textJob())).ok, 'Redis de volta', 15_000);
    assert.ok(!logs.raw().includes(SECRET_TEXT));
    assert.ok(!logs.raw().includes(CONTACT));
  });
});

describe('fila de entrada: privacidade', () => {
  it('erro com texto do contato dentro lançado pelo handler nunca aparece em log (só nome e código)', async () => {
    const { handle, logs, metrics } = setup();
    const { handler } = recordingHandler(() => {
      throw new Error(`falha com ${SECRET_TEXT} e ${CONTACT}`);
    });
    handle.startWorker(handler);
    assert.ok((await handle.queue.enqueue(textJob())).ok);
    await waitFor(async () => (await metricValue(metrics, 'failed')) === 1, 'failed');

    const raw = logs.raw();
    assert.ok(raw.length > 0);
    assert.ok(!raw.includes(SECRET_TEXT));
    assert.ok(!raw.includes(CONTACT));
    const failure = logs.lines().find((line) => line.msg === 'job esgotou as tentativas');
    assert.equal(failure?.errName, 'Error');
    assert.equal(failure.attempts, SETTINGS.attempts);
  });
});
