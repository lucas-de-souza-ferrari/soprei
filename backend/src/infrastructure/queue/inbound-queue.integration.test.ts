import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, afterEach, before, describe, it } from 'node:test';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import {
  type ChannelJob,
  type FlushJob,
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
  companyId: randomUUID(),
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
    job: ChannelJob,
    context: InboundJobContext,
    call: number,
  ) => Promise<'done' | 'discarded'> | 'done' | 'discarded' = () => 'done',
): { handler: InboundJobHandler; calls: { job: ChannelJob; context: InboundJobContext }[] } {
  const calls: { job: ChannelJob; context: InboundJobContext }[] = [];
  return {
    calls,
    handler: async (job, context) => {
      calls.push({ job, context });
      return await behavior(job, context, calls.length);
    },
  };
}

describe('fila de entrada (BullMQ sobre o Redis /15)', () => {
  it('enfileira, o worker processa no contexto do requestId e do companyId do job, e conta completed', async () => {
    const { handle, metrics, logs } = setup();
    const seen: { requestId?: string; companyId?: string }[] = [];
    const { handler, calls } = recordingHandler(() => {
      const context = getContext();
      seen.push({ requestId: context?.requestId, companyId: context?.companyId });
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
    assert.deepEqual(seen, [{ requestId: job.requestId, companyId: job.companyId }]);
    const line = logs.lines().find((entry) => entry.msg === 'dentro do handler');
    assert.equal(line?.requestId, job.requestId);
    assert.equal(line.companyId, job.companyId);
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

  it('reentrega do mesmo evento (mesma empresa e externalId) não gera segundo job; empresas diferentes não colidem', async () => {
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
    assert.equal(calls.length, 2, 'um job por (empresa, externalId)');
    assert.deepEqual(
      new Set(calls.map((call) => call.job.companyId)),
      new Set([job.companyId, other.companyId]),
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
      companyId: 'nao-e-uuid',
      text: SECRET_TEXT,
      contactRef: CONTACT,
    });

    await waitFor(async () => (await metricValue(metrics, 'failed')) === 1, 'failed');
    assert.equal(calls.length, 0);
    assert.ok(!logs.raw().includes(SECRET_TEXT));
    assert.ok(!logs.raw().includes(CONTACT));
  });

  it('job no formato antigo (clientId, spec 022) é descartado: handler não roda, nada é enviado, log só com jobName', async () => {
    const { handle, metrics, logs, prefix } = setup();
    const { handler, calls } = recordingHandler();
    handle.startWorker(handler);

    const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
    rawConnections.push(connection);
    const raw = new Queue(INBOUND_QUEUE_NAME, { connection, prefix });
    rawQueues.push(raw);
    // Job gravado antes da 022: o campo da empresa se chamava `clientId`. O schema novo só aceita `companyId`.
    await raw.add('text', {
      kind: 'text',
      clientId: randomUUID(),
      phoneNumberId: '123',
      externalId: 'wamid.antigo',
      text: SECRET_TEXT,
      contactRef: CONTACT,
    });

    await waitFor(async () => (await metricValue(metrics, 'failed')) === 1, 'failed');
    assert.equal(calls.length, 0);
    assert.equal(await metricValue(metrics, 'completed'), 0);
    assert.ok(logs.raw().includes('job da fila com formato inválido; descartado'));
    assert.ok(!logs.raw().includes(SECRET_TEXT));
    assert.ok(!logs.raw().includes(CONTACT));
    assert.ok(!logs.raw().includes('wamid.antigo'));
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
      if (job.kind !== 'flush') order.push(job.externalId);
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

describe('fila de entrada: falhas que não passam (ou passam) pelo handler', () => {
  it('job que estoura as tentativas é contado como failed UMA vez (o evento do worker não conta de novo) e não aciona o gancho de falha sem handler', async () => {
    const { handle, metrics } = setup();
    const { handler, calls } = recordingHandler(() => {
      throw new ExternalServiceError('sempre falha');
    });
    const unhandled: ChannelJob[] = [];
    handle.startWorker(handler, {
      onUnhandledFailure: (job) => {
        unhandled.push(job);
        return Promise.resolve();
      },
    });
    assert.ok((await handle.queue.enqueue(textJob())).ok);

    await waitFor(async () => (await metricValue(metrics, 'failed')) === 1, 'failed');
    await sleep(300);
    assert.equal(calls.length, SETTINGS.attempts);
    assert.equal(await metricValue(metrics, 'failed'), 1, 'sem dupla contagem');
    assert.equal(unhandled.length, 0);
  });

  it('job parado além do limite falha sem passar pelo handler: log só com campos seguros, métrica failed e o gancho recebe o job', async (t) => {
    const release = keepEventLoopAlive();
    t.after(release);
    const { handle, metrics, logs, prefix } = setup({ stalledIntervalMs: 100, maxStalledCount: 0 });

    // Um "worker" externo pega o job e nunca renova o lock: simula o processo que caiu com ele ativo.
    const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
    rawConnections.push(connection);
    const job = textJob();
    const raw = new Queue(INBOUND_QUEUE_NAME, { connection, prefix });
    rawQueues.push(raw);
    await raw.add(job.kind, job, { jobId: inboundJobId(job), attempts: 3 });
    const crashConnection = connection.duplicate({ maxRetriesPerRequest: null });
    rawConnections.push(crashConnection);
    let taken = false;
    const crashing = new Worker(
      INBOUND_QUEUE_NAME,
      async () => {
        taken = true;
        await sleep(5_000);
      },
      {
        connection: crashConnection,
        prefix,
        lockDuration: 200,
        skipLockRenewal: true,
        // Sem a checagem de parados dele: o BullMQ só deixa UM worker checar por intervalo (chave
        // stalled-check), e o do teste precisa ser o que o outro processo, que não caiu, executa.
        skipStalledCheck: true,
      },
    );
    crashing.on('error', () => undefined);
    await waitFor(() => taken, 'job ativo no worker que "caiu"');

    // O worker de verdade sobe depois e encontra o job parado.
    const handled: ChannelJob[] = [];
    const unhandled: ChannelJob[] = [];
    handle.startWorker(
      (received) => {
        handled.push(received);
        return Promise.resolve('done' as const);
      },
      {
        onUnhandledFailure: (failed) => {
          unhandled.push(failed);
          return Promise.resolve();
        },
      },
    );
    try {
      await waitFor(() => unhandled.length === 1, 'gancho de falha sem handler', 20_000);
    } finally {
      await crashing.close(true).catch(() => undefined);
    }

    assert.deepEqual(unhandled[0], job);
    assert.equal(handled.length, 0, 'o handler nunca viu o job');
    assert.equal(await metricValue(metrics, 'failed'), 1);
    const line = logs.lines().find((entry) => entry.msg === 'job falhou sem passar pelo handler');
    assert.equal(line?.level, 50);
    assert.equal(line.jobKind, 'text');
    const raw2 = logs.raw();
    for (const secret of [SECRET_TEXT, CONTACT, job.externalId, job.companyId, inboundJobId(job)]) {
      assert.ok(!raw2.includes(secret), `vazou em log: ${secret}`);
    }
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

const flushJob = (overrides: Partial<FlushJob> = {}): FlushJob => ({
  kind: 'flush',
  companyId: randomUUID(),
  phoneNumberId: '106540352242922',
  contactRef: CONTACT,
  requestId: `req-${randomUUID()}`,
  ...overrides,
});

describe('fila de entrada: agendamento do flush (spec 013)', () => {
  /** Jobs do BullMQ (sem worker) vistos por uma fila crua sobre o mesmo prefixo. */
  function rawQueue(prefix: string): Queue {
    const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
    rawConnections.push(connection);
    const raw = new Queue(INBOUND_QUEUE_NAME, { connection, prefix });
    rawQueues.push(raw);
    return raw;
  }

  it('um flush por (empresa, contato): slide substitui o que ainda espera e reinicia a espera inteira', async () => {
    const { handle, prefix } = setup();
    const raw = rawQueue(prefix);
    const job = flushJob();

    assert.ok((await handle.queue.scheduleFlush(job, { delayMs: 5_000, mode: 'slide' })).ok);
    const [first] = await raw.getDelayed();
    assert.ok(first !== undefined);
    await sleep(120);
    assert.ok((await handle.queue.scheduleFlush(job, { delayMs: 5_000, mode: 'slide' })).ok);

    const delayed = await raw.getDelayed();
    assert.equal(delayed.length, 1, 'continua um só flush por contato');
    const [second] = delayed;
    assert.ok(second !== undefined);
    assert.notEqual(second.id, first.id, 'o antigo foi substituído');
    assert.ok(
      second.timestamp + second.delay >= first.timestamp + first.delay + 100,
      'a espera reiniciou',
    );
    // O id inclui o companyId e não leva o telefone; o job não leva texto.
    assert.ok(second.id?.includes(job.companyId));
    assert.ok(!(second.id ?? '').includes(CONTACT));
    assert.ok(!(second.id ?? '').includes(':'));
    assert.equal(second.name, 'flush');
    assert.deepEqual(Object.keys(second.data as object).sort(), [
      'companyId',
      'contactRef',
      'kind',
      'phoneNumberId',
      'requestId',
    ]);
    // Sem retenção de jobs concluídos: o contactRef não fica no Redis depois do flush.
    assert.equal(second.opts.removeOnComplete, true);
  });

  it('ensure não adia o flush que já espera; sem flush, cria um', async () => {
    const { handle, prefix } = setup();
    const raw = rawQueue(prefix);
    const job = flushJob();
    assert.ok((await handle.queue.scheduleFlush(job, { delayMs: 5_000, mode: 'ensure' })).ok);
    const [first] = await raw.getDelayed();
    assert.ok(first !== undefined);
    await sleep(60);
    assert.ok((await handle.queue.scheduleFlush(job, { delayMs: 5_000, mode: 'ensure' })).ok);
    const delayed = await raw.getDelayed();
    assert.deepEqual(
      delayed.map((entry) => entry.id),
      [first.id],
    );
  });

  it('o mesmo contactRef em duas empresas tem flush separado; dois contatos do mesma empresa também', async () => {
    const { handle, prefix } = setup();
    const raw = rawQueue(prefix);
    const companyA = randomUUID();
    const companyB = randomUUID();
    for (const job of [
      flushJob({ companyId: companyA }),
      flushJob({ companyId: companyB }),
      flushJob({ companyId: companyA, contactRef: '5511000000001' }),
    ]) {
      assert.ok((await handle.queue.scheduleFlush(job, { delayMs: 5_000, mode: 'slide' })).ok);
    }
    assert.equal((await raw.getDelayed()).length, 3);
    // Reagendar o de A não mexe nos outros.
    assert.ok(
      (
        await handle.queue.scheduleFlush(flushJob({ companyId: companyA }), {
          delayMs: 5_000,
          mode: 'slide',
        })
      ).ok,
    );
    assert.equal((await raw.getDelayed()).length, 3);
  });

  it('o flush roda depois do atraso com o requestId e o companyId no contexto; janela zero roda já', async () => {
    const { handle } = setup();
    const { handler, calls } = recordingHandler();
    handle.startWorker(handler);
    const delayed = flushJob();
    const startedAt = Date.now();
    assert.ok((await handle.queue.scheduleFlush(delayed, { delayMs: 300, mode: 'slide' })).ok);
    await waitFor(() => calls.length === 1, 'flush atrasado');
    assert.ok(Date.now() - startedAt >= 250, 'esperou o atraso');
    assert.deepEqual(calls[0]?.job, delayed);

    const immediate = flushJob();
    assert.ok((await handle.queue.scheduleFlush(immediate, { delayMs: 0, mode: 'slide' })).ok);
    await waitFor(() => calls.length === 2, 'flush imediato');
  });

  it('agendar enquanto o flush do contato está ativo guarda o próximo e o cria quando ele termina (nada fica sem resposta)', async () => {
    const { handle, prefix } = setup();
    const raw = rawQueue(prefix);
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const { handler, calls } = recordingHandler(async (_job, _context, call): Promise<'done'> => {
      if (call === 1) await gate;
      return 'done';
    });
    handle.startWorker(handler);
    const job = flushJob();

    assert.ok((await handle.queue.scheduleFlush(job, { delayMs: 0, mode: 'slide' })).ok);
    await waitFor(() => calls.length === 1, 'primeiro flush ativo');
    // Chega mensagem durante o atendimento (slide) e sobra excedente (ensure): ambos só guardam.
    assert.ok((await handle.queue.scheduleFlush(job, { delayMs: 100, mode: 'slide' })).ok);
    assert.ok((await handle.queue.scheduleFlush(job, { delayMs: 0, mode: 'ensure' })).ok);
    const counts = await handle.jobCounts();
    assert.equal(counts.active, 1);
    assert.equal((counts.waiting ?? 0) + (counts.delayed ?? 0), 0, 'ainda não criou o próximo');

    releaseFirst();
    await waitFor(() => calls.length === 2, 'o próximo flush foi criado e rodou');
    await waitFor(
      async () => (await raw.getJobCounts('completed', 'failed')).failed === 0,
      'sem falha',
    );
    await sleep(100);
    assert.equal(calls.length, 2, 'só um próximo (o último agendamento vence)');
    assert.deepEqual(calls[1]?.job, job);
  });

  it('sem Redis, o agendamento volta como Result.err sem dado do contato; a falha vira erro retentável', async () => {
    const closed = await getClosedPort();
    const logs = captureLogs();
    const handle = createInboundQueue({
      redisUrl: withPort(config.REDIS_URL, closed),
      settings: SETTINGS,
      logger: logs.logger,
      prefix: uniquePrefix(),
      enqueueTimeoutMs: 300,
    });
    open.push(handle);
    const result = await handle.queue.scheduleFlush(flushJob(), { delayMs: 0, mode: 'slide' });
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes(CONTACT));
  });

  it('a retentativa do flush chega com attempt maior que 1', async () => {
    const { handle } = setup();
    const { handler, calls } = recordingHandler((_job, _context, call) => {
      if (call === 1) throw new ExternalServiceError('transitório');
      return 'done';
    });
    handle.startWorker(handler);
    assert.ok((await handle.queue.scheduleFlush(flushJob(), { delayMs: 0, mode: 'slide' })).ok);
    await waitFor(() => calls.length === 2, 'retentativa');
    assert.equal(calls[0]?.context.attempt, 1);
    assert.equal(calls[1]?.context.attempt, 2);
  });
});

describe('fila de entrada: worker concorrente e métricas (spec 034)', () => {
  /** Porta que segura os jobs dentro do handler até o teste liberar. */
  function gate(): { readonly wait: Promise<void>; release(): void } {
    let release: () => void = () => undefined;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      wait,
      release: () => {
        release();
      },
    };
  }

  it('com concurrency 4, quatro jobs de empresas diferentes ficam ativos ao mesmo tempo, cada um no seu contexto', async () => {
    const { handle, logs } = setup({ settings: { ...SETTINGS, concurrency: 4 } });
    const hold = gate();
    let active = 0;
    let peak = 0;
    const { handler, calls } = recordingHandler(async () => {
      active += 1;
      peak = Math.max(peak, active);
      logs.logger.info('job ativo');
      await hold.wait;
      // Depois da espera (outros jobs rodaram no meio), o contexto ainda é o deste job.
      logs.logger.info('job retomado');
      active -= 1;
      return 'done' as const;
    });
    handle.startWorker(handler);
    const jobs = [textJob(), textJob(), textJob(), textJob()];
    for (const job of jobs) assert.ok((await handle.queue.enqueue(job)).ok);

    try {
      await waitFor(() => active === 4, 'quatro jobs ativos juntos');
    } finally {
      hold.release();
    }
    await waitFor(() => active === 0 && calls.length === 4, 'os quatro terminaram');

    assert.equal(peak, 4);
    for (const message of ['job ativo', 'job retomado']) {
      const lines = logs.lines().filter((entry) => entry.msg === message);
      assert.deepEqual(
        new Set(lines.map((entry) => entry.companyId)),
        new Set(jobs.map((job) => job.companyId)),
        `cada job loga a sua empresa em "${message}"`,
      );
      assert.deepEqual(
        new Set(lines.map((entry) => entry.requestId)),
        new Set(jobs.map((job) => job.requestId)),
      );
    }
    assert.ok(!logs.raw().includes(SECRET_TEXT));
    assert.ok(!logs.raw().includes(CONTACT));
  });

  it('sem concurrency nas opções (padrão 1), o segundo job só começa quando o primeiro termina', async () => {
    const { handle } = setup();
    const hold = gate();
    let active = 0;
    let peak = 0;
    const { handler, calls } = recordingHandler(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await hold.wait;
      active -= 1;
      return 'done' as const;
    });
    handle.startWorker(handler);
    assert.ok((await handle.queue.enqueue(textJob())).ok);
    assert.ok((await handle.queue.enqueue(textJob())).ok);

    try {
      await waitFor(() => calls.length === 1, 'primeiro job ativo');
      await sleep(300);
      assert.equal(calls.length, 1, 'o segundo espera o primeiro');
    } finally {
      hold.release();
    }
    await waitFor(() => calls.length === 2 && active === 0, 'os dois terminaram');
    assert.equal(peak, 1);
  });

  it('com concurrency 4, o flush de um mesmo contato nunca roda duas vezes ao mesmo tempo', async () => {
    const { handle } = setup({ settings: { ...SETTINGS, concurrency: 4 } });
    const contact = flushJob();
    const other = flushJob();
    const activeByCompany = new Map<string, number>();
    let overlap = false;
    let sawBothCompanies = false;
    const { handler, calls } = recordingHandler(async (job) => {
      const current = (activeByCompany.get(job.companyId) ?? 0) + 1;
      activeByCompany.set(job.companyId, current);
      if (current > 1) overlap = true;
      if (activeByCompany.size === 2 && [...activeByCompany.values()].every((n) => n > 0)) {
        sawBothCompanies = true;
      }
      await sleep(250);
      activeByCompany.set(job.companyId, (activeByCompany.get(job.companyId) ?? 1) - 1);
      return 'done' as const;
    });
    handle.startWorker(handler);

    // O mesmo contato pede resposta três vezes enquanto o primeiro flush roda; outro contato em paralelo.
    assert.ok((await handle.queue.scheduleFlush(contact, { delayMs: 0, mode: 'ensure' })).ok);
    assert.ok((await handle.queue.scheduleFlush(other, { delayMs: 0, mode: 'ensure' })).ok);
    await waitFor(() => calls.length >= 2, 'os dois contatos em atendimento');
    assert.ok((await handle.queue.scheduleFlush(contact, { delayMs: 0, mode: 'ensure' })).ok);
    assert.ok((await handle.queue.scheduleFlush(contact, { delayMs: 0, mode: 'slide' })).ok);

    // O flush guardado (`keepLastIfActive`) roda depois que o ativo termina.
    await waitFor(() => calls.length >= 3, 'o flush guardado rodou');
    await waitFor(() => [...activeByCompany.values()].every((n) => n === 0), 'tudo terminou');
    await sleep(400);

    assert.equal(overlap, false, 'nunca dois flush do mesmo contato ao mesmo tempo');
    assert.equal(sawBothCompanies, true, 'contatos diferentes rodaram em paralelo');
    assert.equal(
      calls.filter((call) => call.job.companyId === other.companyId).length,
      1,
      'o outro contato rodou uma vez',
    );
  });

  it('queue_jobs em /metrics bate com jobCounts()', async () => {
    const { handle, metrics } = setup();
    metrics.bindQueue(INBOUND_QUEUE_NAME, () => handle.jobCounts());
    for (let i = 0; i < 3; i += 1) assert.ok((await handle.queue.enqueue(textJob())).ok);
    assert.ok(
      (await handle.queue.scheduleFlush(flushJob(), { delayMs: 60_000, mode: 'slide' })).ok,
    );

    const counts = await handle.jobCounts();
    const body = await metrics.render();

    assert.equal(counts.waiting, 3);
    assert.equal(counts.delayed, 1);
    for (const state of ['waiting', 'active', 'delayed', 'failed'] as const) {
      assert.ok(
        body.includes(
          `queue_jobs{queue="${INBOUND_QUEUE_NAME}",state="${state}"} ${String(counts[state] ?? 0)}\n`,
        ),
        state,
      );
    }
  });

  it('cada job processado deixa uma observação de duração e de espera, com o tipo certo', async () => {
    const { handle, metrics } = setup({ settings: { ...SETTINGS, concurrency: 2 } });
    const { handler, calls } = recordingHandler();
    handle.startWorker(handler);
    assert.ok((await handle.queue.enqueue(textJob())).ok);
    assert.ok((await handle.queue.scheduleFlush(flushJob(), { delayMs: 0, mode: 'ensure' })).ok);
    await waitFor(() => calls.length === 2, 'os dois jobs');

    await waitFor(async () => {
      const body = await metrics.render();
      return ['text', 'flush'].every(
        (kind) =>
          body.includes(
            `queue_job_duration_seconds_count{queue="${INBOUND_QUEUE_NAME}",kind="${kind}"} 1`,
          ) &&
          body.includes(
            `queue_job_wait_seconds_count{queue="${INBOUND_QUEUE_NAME}",kind="${kind}"} 1`,
          ),
      );
    }, 'duração e espera observadas por tipo');
  });

  it('Redis da fila fora: /metrics responde, queue_jobs fica sem amostra e o erro é contado', async () => {
    const logs = captureLogs();
    const metrics = createMetrics();
    const handle = createInboundQueue({
      redisUrl: withPort(config.REDIS_URL, await getClosedPort()),
      settings: SETTINGS,
      logger: logs.logger,
      metrics,
      prefix: uniquePrefix(),
      enqueueTimeoutMs: 300,
    });
    open.push(handle);
    metrics.bindQueue(INBOUND_QUEUE_NAME, () => handle.jobCounts());

    const begin = Date.now();
    const body = await metrics.render();

    assert.ok(Date.now() - begin < 5_000, 'a coleta não fica pendurada');
    assert.ok(!body.includes('queue_jobs{'));
    assert.ok(body.includes('queue_metrics_errors_total 1'));
    assert.ok(body.includes('process_cpu_user_seconds_total'));
  });
});

describe('fila de entrada: limpeza por idade (spec 035, E3)', () => {
  const CLEANED_TEXT = 'texto-secreto-que-a-limpeza-apaga-7c1';
  const KEEP = { ...SETTINGS, keepCompletedSeconds: 3, keepFailedSeconds: 3 };

  /** Chaves do hash de um job no Redis (`<prefixo>:<fila>:<id>`). */
  const jobKey = (prefix: string, id: string): string => `${prefix}:${INBOUND_QUEUE_NAME}:${id}`;

  it('apaga o concluído e o falho mais velhos que os prazos sem nenhum outro job terminar; o recente fica', async () => {
    const h = setup({ settings: KEEP });
    const old = textJob({ text: CLEANED_TEXT });
    const failing = textJob({ text: CLEANED_TEXT });
    const { handler } = recordingHandler((job) => {
      if (job.kind === 'text' && job.externalId === failing.externalId) {
        throw new NonRetryableJobError('permanente');
      }
      return 'done';
    });
    h.handle.startWorker(handler);

    assert.ok((await h.handle.queue.enqueue(old)).ok);
    assert.ok((await h.handle.queue.enqueue(failing)).ok);
    await waitFor(async () => {
      const counts = await h.handle.jobCounts();
      return counts.completed === 1 && counts.failed === 1;
    }, 'um concluído e um falho');
    // O recente termina ANTES de o antigo passar do prazo (3 s): a conclusão de um job faz o BullMQ
    // apagar os concluídos vencidos (removeOnComplete por idade), e isso não pode acontecer aqui.
    await sleep(1_200);
    const fresh = textJob();
    assert.ok((await h.handle.queue.enqueue(fresh)).ok);
    await waitFor(async () => (await h.handle.jobCounts()).completed === 2, 'o recente concluído');
    // Agora o antigo passa do prazo sem nenhum outro job terminar: só a limpeza o apaga.
    await sleep(2_300);

    const cleaned = await h.handle.cleaner.cleanOldJobs();
    assert.ok(cleaned.ok);
    assert.deepEqual(cleaned.value, { completed: 1, failed: 1 });

    const counts = await h.handle.jobCounts();
    assert.equal(counts.completed, 1, 'o recente fica');
    assert.equal(counts.failed, 0);
    assert.equal(await cleanupRedis.exists(jobKey(h.prefix, inboundJobId(old))), 0);
    assert.equal(await cleanupRedis.exists(jobKey(h.prefix, inboundJobId(failing))), 0);
    assert.equal(await cleanupRedis.exists(jobKey(h.prefix, inboundJobId(fresh))), 1);

    // Nenhum hash sob o prefixo da fila guarda mais o texto dos jobs apagados.
    for (const key of await keyspace.keysUnder(cleanupRedis, `${h.prefix}:`)) {
      if ((await cleanupRedis.type(key)) !== 'hash') continue;
      const values = Object.values(await cleanupRedis.hgetall(key));
      assert.ok(!values.some((value) => value.includes(CLEANED_TEXT)), `texto em ${key}`);
    }
  });

  it('nunca toca job ativo, em espera ou atrasado', async () => {
    const h = setup({ settings: KEEP });
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { handler } = recordingHandler(async (_job, _context, call): Promise<'done'> => {
      if (call === 1) await blocked;
      return 'done';
    });
    h.handle.startWorker(handler);
    try {
      assert.ok((await h.handle.queue.enqueue(textJob())).ok);
      await waitFor(async () => (await h.handle.jobCounts()).active === 1, 'um ativo');
      assert.ok((await h.handle.queue.enqueue(textJob())).ok);
      assert.ok(
        (await h.handle.queue.scheduleFlush(flushJob(), { delayMs: 60_000, mode: 'ensure' })).ok,
      );
      await sleep(3_400);

      const cleaned = await h.handle.cleaner.cleanOldJobs();
      assert.ok(cleaned.ok);
      assert.deepEqual(cleaned.value, { completed: 0, failed: 0 });
      const counts = await h.handle.jobCounts();
      assert.equal(counts.active, 1);
      assert.equal(counts.waiting, 1);
      assert.equal(counts.delayed, 1);
    } finally {
      release();
    }
  });

  it('Redis fora: a limpeza devolve erro, sem lançar e sem o erro do driver como causa', async () => {
    const port = await getClosedPort();
    const h = setup({ redisUrl: withPort(config.REDIS_URL, port), enqueueTimeoutMs: 300 });
    const cleaned = await h.handle.cleaner.cleanOldJobs();
    assert.ok(!cleaned.ok);
    assert.ok(cleaned.error instanceof ExternalServiceError);
    assert.equal(cleaned.error.cause, undefined);
  });
});
