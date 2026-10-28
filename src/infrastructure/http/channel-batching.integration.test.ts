import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, afterEach, before, describe, it } from 'node:test';
import { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { AttendanceService } from '../../application/attendance/attendance.service.js';
import {
  type ChannelBatchSettings,
  ChannelInboundProcessor,
} from '../../application/channel/channel-inbound.processor.js';
import { ChannelIntakeService } from '../../application/channel/channel-intake.service.js';
import { CHANNEL_NOTICE_TEXTS } from '../../application/channel/channel-texts.js';
import type { Client } from '../../domain/index.js';
import { Result } from '../../shared/types/index.js';
import { FakeGraphApi } from '../../test-support/fake-graph-api.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { keepEventLoopAlive } from '../../test-support/keep-alive.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { TestKeyspace } from '../../test-support/test-keyspace.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import {
  fakeWamid,
  signWebhookBody,
  webhookPayload,
} from '../../test-support/whatsapp-payloads.js';
import { createRedis } from '../cache/redis.client.js';
import {
  createDatabase,
  type Database,
  PrismaAttendanceUnitOfWork,
  PrismaClientRepository,
  PrismaConversationRepository,
  PrismaMessageRepository,
} from '../database/index.js';
import { MockLlmProvider } from '../external-apis/llm/mock-llm.provider.js';
import { WhatsappCloudApiClient } from '../external-apis/whatsapp/whatsapp-cloud-api.client.js';
import { closeInfrastructure } from '../lifecycle.js';
import { createMetrics } from '../metrics/index.js';
import {
  createInboundQueue,
  INBOUND_QUEUE_NAME,
  type InboundQueueHandle,
} from '../queue/inbound-queue.js';
import { buildServer } from './server.js';

// Falha aqui (antes de abrir qualquer conexão) se o ambiente não for o de testes (soprei_test, Redis /15).
const config = loadIntegrationConfig();

const APP_SECRET = `app-secret-${randomUUID()}`;
const VERIFY_TOKEN = `verify-token-${randomUUID()}`;
const ACCESS_TOKEN = `EAAG-access-${randomUUID()}`;
const METRICS_TOKEN = `metrics-${randomUUID()}-${randomUUID()}`;
const PERSONA = 'persona-secreta-lote';
const SECRET_TEXT = 'texto-secreto-do-lote-c41';
const QUEUE_SETTINGS = {
  attempts: 5,
  backoffMs: 100,
  keepCompletedSeconds: 600,
  keepFailedSeconds: 600,
};
const VERSION = 'v26.0';

const graph = new FakeGraphApi();
const keyspace = new TestKeyspace();
let fixturesDb: Database;
let tenants: TestTenants;
let cleanupRedis: Redis;

before(async () => {
  await graph.start();
  fixturesDb = createDatabase(config, captureLogs('silent').logger);
  tenants = new TestTenants(fixturesDb.prisma);
  cleanupRedis = new Redis(config.REDIS_URL);
});

after(async () => {
  try {
    await tenants.cleanup();
  } finally {
    await fixturesDb.close();
    cleanupRedis.disconnect();
    await graph.stop();
  }
});

afterEach(async () => {
  graph.reset();
  await keyspace.cleanup(cleanupRedis);
});

const phoneNumberId = (): string =>
  `9${randomBytes(6).readUIntBE(0, 6).toString().padStart(15, '0')}`;
const contactNumber = (): string =>
  `5511${randomBytes(4).readUInt32BE(0).toString().padStart(10, '0')}`;

interface Harness {
  readonly app: FastifyInstance;
  readonly llm: MockLlmProvider;
  readonly logs: ReturnType<typeof captureLogs>;
  readonly queue: InboundQueueHandle;
  readonly prefix: string;
  stop(): Promise<void>;
}

async function start(batch: ChannelBatchSettings): Promise<Harness> {
  const logs = captureLogs();
  const metrics = createMetrics();
  const database = createDatabase(config, logs.logger);
  const redis = createRedis(config, logs.logger);
  const prefix = keyspace.scopedPrefix('bull').slice(0, -1);
  const queue = createInboundQueue({
    redisUrl: config.REDIS_URL,
    settings: QUEUE_SETTINGS,
    logger: logs.logger,
    metrics,
    prefix,
    enqueueTimeoutMs: 800,
  });
  const llm = new MockLlmProvider({ recordCalls: true });
  const { prisma } = database;
  const clients = new PrismaClientRepository(prisma);
  const messages = new PrismaMessageRepository(prisma);
  const attendance = new AttendanceService({
    clients,
    conversations: new PrismaConversationRepository(prisma),
    messages,
    unitOfWork: new PrismaAttendanceUnitOfWork(prisma),
    llm,
    logger: logs.logger,
    metrics,
    options: { llmTimeoutMs: 5_000, inFlightTimeoutMs: 60_000 },
  });
  const processor = new ChannelInboundProcessor({
    attendance,
    clients,
    messages,
    sender: new WhatsappCloudApiClient({
      baseUrl: graph.baseUrl,
      graphApiVersion: VERSION,
      accessToken: ACCESS_TOKEN,
      timeoutMs: 1_000,
      metrics,
    }),
    queue: queue.queue,
    batch,
    logger: logs.logger,
  });
  queue.startWorker((job, context) => processor.process(job, context), {
    onUnhandledFailure: (job) => processor.handleUnprocessedFailure(job),
  });
  const app = buildServer({
    logger: logs.logger,
    metrics,
    metricsToken: METRICS_TOKEN,
    readiness: {
      database: () => Promise.resolve(Result.ok(undefined)),
      redis: () => Promise.resolve(Result.ok(undefined)),
    },
    whatsapp: {
      appSecret: APP_SECRET,
      verifyToken: VERIFY_TOKEN,
      intake: new ChannelIntakeService({
        clients,
        queue: queue.queue,
        logger: logs.logger,
        metrics,
        channel: 'whatsapp',
      }),
    },
  });
  await app.ready();

  let stopped = false;
  return {
    app,
    llm,
    logs,
    queue,
    prefix,
    async stop() {
      if (stopped) return;
      stopped = true;
      await app.close();
      await closeInfrastructure({ database, redis, inboundQueue: queue }, logs.logger);
    },
  };
}

async function withHarness(
  batch: Partial<ChannelBatchSettings>,
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const h = await start({
    windowMs: 300,
    maxWaitMs: 1_500,
    maxMessages: 10,
    maxChars: 8_000,
    ...batch,
  });
  try {
    await fn(h);
  } finally {
    await h.stop();
  }
}

async function newClient(label: string, number: string): Promise<Client> {
  const client = await tenants.createClient(label, number);
  await fixturesDb.prisma.client.updateMany({
    where: { id: client.id },
    data: { persona: `${PERSONA} ${label}` },
  });
  return client;
}

async function send(
  h: Harness,
  number: string,
  contact: string,
  text: string,
  extra: { type?: string } = {},
): Promise<string> {
  const id = fakeWamid(contact, `-${randomUUID()}`);
  const body = JSON.stringify(
    webhookPayload([
      {
        phoneNumberId: number,
        messages: [
          { id, from: contact, ...(extra.type === undefined ? { text } : { type: extra.type }) },
        ],
      },
    ]),
  );
  const response = await h.app.inject({
    method: 'POST',
    url: '/webhooks/whatsapp',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signWebhookBody(body, APP_SECRET),
    },
    payload: body,
  });
  assert.equal(response.statusCode, 200);
  return id;
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(15);
  }
  throw new Error(`tempo esgotado esperando: ${label}`);
}

async function stored(client: Client, contact: string) {
  const conversation = await fixturesDb.prisma.conversation.findFirst({
    where: { clientId: client.id, contactRef: contact },
  });
  if (conversation === null) return [];
  return fixturesDb.prisma.message.findMany({
    where: { clientId: client.id, conversationId: conversation.id },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

const sentCount = async (client: Client, contact: string): Promise<number> =>
  (await stored(client, contact)).filter((m) => m.role === 'ASSISTANT' && m.sentAt !== null).length;
const userCount = async (client: Client, contact: string): Promise<number> =>
  (await stored(client, contact)).filter((m) => m.role === 'USER').length;
const textsSent = (): string[] =>
  graph.requests.map((request) => (request.body as { text: { body: string } }).text.body);

describe('agrupamento de mensagens no canal (janela deslizante, spec 013)', () => {
  it('três mensagens dentro da janela: uma chamada ao LLM com um turno user, uma resposta, todas marcadas', async () => {
    await withHarness({}, async (h) => {
      const number = phoneNumberId();
      const client = await newClient('lote', number);
      const contact = contactNumber();
      // Um turno antigo já respondido: é o histórico do lote.
      await send(h, number, contact, 'pergunta antiga');
      await waitFor(async () => (await sentCount(client, contact)) === 1, 'turno antigo');
      h.llm.calls.length = 0;
      graph.requests.length = 0;

      await send(h, number, contact, 'oi');
      await send(h, number, contact, 'tudo bem?');
      await send(h, number, contact, 'preciso de ajuda');
      await waitFor(async () => (await sentCount(client, contact)) === 2, 'resposta do lote');
      await sleep(400);

      assert.equal(h.llm.calls.length, 1, 'uma só chamada ao LLM');
      const [call] = h.llm.calls;
      assert.equal(call?.userMessage, 'oi\ntudo bem?\npreciso de ajuda');
      assert.deepEqual(
        call.history.map((turn) => [turn.role, turn.content.slice(0, 16)]),
        [
          ['user', 'pergunta antiga'],
          ['assistant', '[mock] Recebi: p'],
        ],
      );
      assert.equal(graph.requests.length, 1, 'um só envio');
      const rows = await stored(client, contact);
      const reply = rows.filter((m) => m.role === 'ASSISTANT').at(-1);
      assert.ok(reply !== undefined);
      const batch = rows.filter((m) => m.role === 'USER').slice(-3);
      assert.ok(batch.every((m) => m.answeredById === reply.id));
      assert.equal(reply.replyToId, batch[2]?.id, 'replyToId = a última mensagem do lote');
      assert.equal(reply.channelMessageId !== null, true);
    });
  });

  it('janela deslizante: mensagem nova dentro da janela adia a resposta; o job flush não leva texto e a chave inclui o cliente', async (t) => {
    const release = keepEventLoopAlive();
    t.after(release);
    await withHarness({ windowMs: 700, maxWaitMs: 5_000 }, async (h) => {
      const number = phoneNumberId();
      const client = await newClient('desliza', number);
      const contact = contactNumber();
      const rawConnection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
      const raw = new Queue(INBOUND_QUEUE_NAME, { connection: rawConnection, prefix: h.prefix });
      t.after(async () => {
        await raw.close();
        rawConnection.disconnect();
      });

      const begin = Date.now();
      await send(h, number, contact, `${SECRET_TEXT} primeira`);
      await waitFor(async () => (await userCount(client, contact)) === 1, 'primeira aceita');
      const [flush] = await raw.getDelayed();
      assert.ok(flush !== undefined, 'há um flush esperando');
      assert.equal(flush.name, 'flush');
      assert.ok(!JSON.stringify(flush.data).includes(SECRET_TEXT), 'o job não leva texto');
      assert.ok(flush.id?.includes(client.id), 'a chave do flush inclui o clientId');
      assert.ok(!flush.id?.includes(contact), 'e não o telefone');

      await sleep(350);
      await send(h, number, contact, 'segunda');
      await waitFor(async () => (await userCount(client, contact)) === 2, 'segunda aceita');
      const secondAcceptedAt = Date.now();
      // Passou a janela da primeira (700 ms desde `begin`): sem deslizar, a resposta já teria saído.
      await sleep(Math.max(0, begin + 700 + 150 - Date.now()));
      assert.equal(h.llm.calls.length, 0, 'a segunda mensagem adiou a resposta');
      assert.equal((await raw.getDelayed()).length, 1, 'ainda um só flush esperando');

      await waitFor(
        async () => (await sentCount(client, contact)) === 1,
        'resposta depois da janela',
      );
      assert.ok(
        Date.now() - secondAcceptedAt >= 600,
        'esperou a janela inteira a partir da segunda',
      );
      assert.equal(h.llm.calls.length, 1);
      assert.match(h.llm.calls[0]?.userMessage ?? '', /primeira\nsegunda$/);
    });
  });

  it('teto de espera: quem escreve sem parar recebe resposta ao completar o teto, e as seguintes viram o turno seguinte', async () => {
    await withHarness({ windowMs: 500, maxWaitMs: 1_100 }, async (h) => {
      const number = phoneNumberId();
      const client = await newClient('teto', number);
      const contact = contactNumber();

      const total = 12;
      let firstReplyAfterSent = -1;
      for (let i = 1; i <= total; i += 1) {
        await send(h, number, contact, `m${String(i)}`);
        if (firstReplyAfterSent === -1 && h.llm.calls.length > 0) firstReplyAfterSent = i;
        await sleep(200);
      }
      assert.ok(firstReplyAfterSent !== -1, 'respondeu antes de o contato parar de escrever');
      assert.ok(firstReplyAfterSent < total, 'o primeiro turno saiu no meio da sequência');

      await waitFor(
        async () => (await userCount(client, contact)) === total && h.llm.calls.length >= 2,
        'segundo turno',
      );
      await waitFor(
        async () =>
          (await stored(client, contact)).every(
            (m) => m.role !== 'USER' || m.answeredById !== null,
          ),
        'todas respondidas',
      );
      // Nenhuma mensagem perdida nem repetida, na ordem.
      const joined = h.llm.calls.flatMap((call) => call.userMessage.split('\n'));
      assert.deepEqual(
        joined,
        Array.from({ length: total }, (_, i) => `m${String(i + 1)}`),
      );
      assert.ok(h.llm.calls.length >= 2);
    });
  });

  it('mensagens separadas por mais que a janela geram duas respostas, na ordem', async () => {
    await withHarness({ windowMs: 250 }, async (h) => {
      const number = phoneNumberId();
      const client = await newClient('duas', number);
      const contact = contactNumber();

      await send(h, number, contact, 'primeira');
      await waitFor(async () => (await sentCount(client, contact)) === 1, 'primeira resposta');
      await send(h, number, contact, 'segunda');
      await waitFor(async () => (await sentCount(client, contact)) === 2, 'segunda resposta');

      assert.deepEqual(
        h.llm.calls.map((call) => call.userMessage),
        ['primeira', 'segunda'],
      );
      assert.equal(graph.requests.length, 2);
      assert.match(textsSent()[0] ?? '', /primeira/);
      assert.match(textsSent()[1] ?? '', /segunda/);
    });
  });

  it('janela zero responde sem espera, com atraso zero agendado', async () => {
    await withHarness({ windowMs: 0, maxWaitMs: 0 }, async (h) => {
      const number = phoneNumberId();
      const client = await newClient('zero', number);
      const contact = contactNumber();
      await send(h, number, contact, 'sem espera');
      await waitFor(
        async () => (await sentCount(client, contact)) === 1,
        'resposta imediata',
        3_000,
      );
      const line = h.logs
        .lines()
        .find((entry) => entry.msg === 'resposta agendada para o fim da janela de espera');
      assert.equal(line?.delayMs, 0);
    });
  });

  it('mais pendentes que o limite de mensagens ou de caracteres: turnos sucessivos, sem perder nenhuma e sem nova espera', async () => {
    await withHarness({ windowMs: 400, maxMessages: 2, maxChars: 8_000 }, async (h) => {
      const number = phoneNumberId();
      const client = await newClient('limite', number);
      const contact = contactNumber();
      for (let i = 1; i <= 5; i += 1) await send(h, number, contact, `m${String(i)}`);
      await waitFor(async () => (await sentCount(client, contact)) === 3, 'três turnos');
      assert.deepEqual(
        h.llm.calls.map((call) => call.userMessage),
        ['m1\nm2', 'm3\nm4', 'm5'],
      );
      const users = (await stored(client, contact)).filter((m) => m.role === 'USER');
      assert.ok(users.every((user) => user.answeredById !== null));
    });
    await withHarness({ windowMs: 400, maxMessages: 10, maxChars: 70 }, async (h) => {
      const number = phoneNumberId();
      const client = await newClient('limite-chars', number);
      const contact = contactNumber();
      for (const letter of ['a', 'b', 'c']) await send(h, number, contact, letter.repeat(30));
      await waitFor(async () => (await sentCount(client, contact)) === 2, 'dois turnos');
      // 30 + 1 + 30 = 61 cabe em 70; a terceira (92) vira o turno seguinte.
      assert.deepEqual(
        h.llm.calls.map((call) => call.userMessage.length),
        [61, 30],
      );
    });
  });

  it('mensagem que chega durante a chamada ao LLM recebe a sua própria resposta depois e não entra no lote em andamento', async (t) => {
    const release = keepEventLoopAlive();
    t.after(release);
    await withHarness({ windowMs: 200 }, async (h) => {
      const number = phoneNumberId();
      const client = await newClient('durante', number);
      const contact = contactNumber();
      const open = h.llm.hold();
      t.after(open);

      await send(h, number, contact, 'primeira');
      await waitFor(() => h.llm.calls.length === 1, 'flush ativo, LLM segurado');
      await send(h, number, contact, 'chegou durante');
      await sleep(300);
      open();

      await waitFor(async () => (await sentCount(client, contact)) === 2, 'duas respostas');
      assert.deepEqual(
        h.llm.calls.map((call) => call.userMessage),
        ['primeira', 'chegou durante'],
      );
      assert.deepEqual(
        h.llm.calls[1]?.history.map((turn) => [turn.role, turn.content.slice(0, 16)]),
        [
          ['user', 'primeira'],
          ['assistant', '[mock] Recebi: p'],
        ],
        'o segundo turno enxerga o primeiro e a resposta dele',
      );
      const users = (await stored(client, contact)).filter((m) => m.role === 'USER');
      assert.ok(users.every((user) => user.answeredById !== null));
      assert.equal(graph.requests.length, 2);
    });
  });

  it('aviso constante (áudio) não espera e não entra no lote; o texto pendente continua esperando a janela', async () => {
    await withHarness({ windowMs: 1_500, maxWaitMs: 5_000 }, async (h) => {
      const number = phoneNumberId();
      const client = await newClient('aviso', number);
      const contact = contactNumber();

      await send(h, number, contact, 'texto pendente');
      await waitFor(async () => (await userCount(client, contact)) === 1, 'texto aceito');
      await send(h, number, contact, '', { type: 'audio' });
      await waitFor(() => graph.requests.length === 1, 'aviso enviado', 1_200);
      assert.equal(textsSent()[0], CHANNEL_NOTICE_TEXTS.unsupported_type);
      assert.equal(h.llm.calls.length, 0, 'o texto ainda espera a janela');

      await waitFor(async () => (await sentCount(client, contact)) === 1, 'resposta ao texto');
      assert.equal(h.llm.calls[0]?.userMessage, 'texto pendente');
      assert.equal(await userCount(client, contact), 1, 'o aviso não foi gravado nem agrupado');
    });
  });

  it('dois contatos do mesmo cliente e o mesmo contato em dois clientes escrevendo juntos nunca se misturam', async () => {
    await withHarness({ windowMs: 300 }, async (h) => {
      const numberA = phoneNumberId();
      const numberB = phoneNumberId();
      const clientA = await newClient('iso-a', numberA);
      const clientB = await newClient('iso-b', numberB);
      const same = contactNumber();
      const other = contactNumber();

      await send(h, numberA, same, 'A-um');
      await send(h, numberB, same, 'B-um');
      await send(h, numberA, other, 'A-outro');
      await send(h, numberA, same, 'A-dois');
      await send(h, numberB, same, 'B-dois');
      await waitFor(
        async () =>
          (await sentCount(clientA, same)) === 1 &&
          (await sentCount(clientB, same)) === 1 &&
          (await sentCount(clientA, other)) === 1,
        'três respostas',
      );

      const byText = new Map(h.llm.calls.map((call) => [call.userMessage, call]));
      assert.deepEqual(
        [...byText.keys()].sort(),
        ['A-um\nA-dois', 'B-um\nB-dois', 'A-outro'].sort(),
      );
      assert.match(byText.get('A-um\nA-dois')?.systemPrompt ?? '', /iso-a/);
      assert.match(byText.get('B-um\nB-dois')?.systemPrompt ?? '', /iso-b/);
      assert.deepEqual(byText.get('A-um\nA-dois')?.history, []);
      // Cada resposta saiu pelo número do seu cliente.
      const pairs = graph.requests.map((request) => [
        request.phoneNumberId,
        (request.body as { to: string }).to,
      ]);
      assert.equal(pairs.filter(([n, to]) => n === numberA && to === same).length, 1);
      assert.equal(pairs.filter(([n, to]) => n === numberB && to === same).length, 1);
      assert.equal(pairs.filter(([n, to]) => n === numberA && to === other).length, 1);
      assert.equal(pairs.length, 3);
    });
  });

  it('cliente suspenso ou número trocado durante a espera: o flush é descartado e nada é enviado', async () => {
    await withHarness({ windowMs: 500 }, async (h) => {
      const numberS = phoneNumberId();
      const numberC = phoneNumberId();
      const suspended = await newClient('susp', numberS);
      const changed = await newClient('troca', numberC);
      const contact = contactNumber();
      await send(h, numberS, contact, 'oi');
      await send(h, numberC, contact, 'oi');
      await waitFor(
        async () =>
          (await userCount(suspended, contact)) === 1 && (await userCount(changed, contact)) === 1,
        'mensagens aceitas',
      );
      await fixturesDb.prisma.client.updateMany({
        where: { id: suspended.id },
        data: { status: 'SUSPENDED' },
      });
      await fixturesDb.prisma.client.updateMany({
        where: { id: changed.id },
        data: { whatsappPhoneNumberId: phoneNumberId() },
      });

      await waitFor(
        () =>
          h.logs
            .lines()
            .some(
              (line) =>
                line.msg === 'cliente suspenso; nada é enviado ao contato e o job é descartado',
            ),
        'flush descartado',
      );
      await waitFor(
        () => h.logs.lines().some((line) => String(line.msg).includes('o número do cliente mudou')),
        'número trocado detectado',
      );
      assert.equal(graph.requests.length, 0, 'nada chegou ao Graph');
    });
  });

  it('as métricas do lote aparecem em /metrics; texto, contato, persona e segredos não aparecem em nenhum log', async () => {
    await withHarness({ windowMs: 250 }, async (h) => {
      const number = phoneNumberId();
      const client = await newClient('privado', number);
      const contact = contactNumber();
      await send(h, number, contact, `${SECRET_TEXT} 1`);
      await send(h, number, contact, `${SECRET_TEXT} 2`);
      await waitFor(async () => (await sentCount(client, contact)) === 1, 'resposta');
      await send(h, number, contact, `${SECRET_TEXT} [[mock:fail]]`);
      await waitFor(async () => (await sentCount(client, contact)) === 2, 'fallback enviado');

      const response = await h.app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: `Bearer ${METRICS_TOKEN}` },
      });
      assert.match(response.body, /attendance_batches_total\{result="answered"\} 2/);
      assert.match(response.body, /attendance_batch_size_count 2/);
      assert.match(response.body, /attendance_batch_size_sum 3/);
      assert.match(
        response.body,
        /queue_jobs_total\{queue="channel-inbound",result="completed"\} /,
      );
      assert.doesNotMatch(response.body, new RegExp(`${client.id}|${contact}|${SECRET_TEXT}`));

      const raw = h.logs.raw();
      for (const secret of [
        SECRET_TEXT,
        contact,
        PERSONA,
        APP_SECRET,
        VERIFY_TOKEN,
        ACCESS_TOKEN,
      ]) {
        assert.ok(!raw.includes(secret), `vazou em log: ${secret}`);
      }
      assert.ok(raw.includes('lote de mensagens atendido'));
    });
  });
});
