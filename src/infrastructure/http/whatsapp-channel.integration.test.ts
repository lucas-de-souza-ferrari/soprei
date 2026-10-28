import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, afterEach, before, describe, it } from 'node:test';
import { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import {
  ATTENDANCE_FALLBACK_TEXT,
  AttendanceService,
} from '../../application/attendance/attendance.service.js';
import { ChannelInboundProcessor } from '../../application/channel/channel-inbound.processor.js';
import { ChannelIntakeService } from '../../application/channel/channel-intake.service.js';
import { CHANNEL_NOTICE_TEXTS } from '../../application/channel/channel-texts.js';
import type { Client } from '../../domain/index.js';
import { DatabaseError } from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import { FakeGraphApi, graphError } from '../../test-support/fake-graph-api.js';
import { getClosedPort, withPort } from '../../test-support/closed-port.js';
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
import { createRateLimitRedis } from '../cache/rate-limit-redis.js';
import { createRedis } from '../cache/redis.client.js';
import {
  createDatabase,
  type Database,
  PrismaAttendanceUnitOfWork,
  PrismaClientRepository,
  PrismaConversationRepository,
  PrismaMessageRepository,
} from '../database/index.js';
import {
  MOCK_FAIL_MARKER,
  MOCK_HANG_MARKER,
  MockLlmProvider,
} from '../external-apis/llm/mock-llm.provider.js';
import { WhatsappCloudApiClient } from '../external-apis/whatsapp/whatsapp-cloud-api.client.js';
import { closeInfrastructure } from '../lifecycle.js';
import { createMetrics } from '../metrics/index.js';
import {
  createInboundQueue,
  INBOUND_QUEUE_NAME,
  type InboundQueueHandle,
} from '../queue/inbound-queue.js';
import { rateLimitProfilesFromConfig } from './rate-limit/rate-limit.js';
import { buildServer } from './server.js';

// Falha aqui (antes de abrir qualquer conexão) se o ambiente não for o de testes (soprei_test, Redis /15).
const config = loadIntegrationConfig();

const APP_SECRET = `app-secret-${randomUUID()}`;
const VERIFY_TOKEN = `verify-token-${randomUUID()}`;
const ACCESS_TOKEN = `EAAG-access-${randomUUID()}`;
const METRICS_TOKEN = `metrics-${randomUUID()}-${randomUUID()}`;
const PERSONA = 'persona-secreta-e2e';
const PROFILE_NAME = 'Nome Secreto de Perfil E2E';
const QUEUE_SETTINGS = {
  attempts: 5,
  backoffMs: 100,
  keepCompletedSeconds: 600,
  keepFailedSeconds: 600,
};
/** Prazos curtos de propósito: o timeout do LLM e o de "em andamento" cabem no tempo do teste. */
const LLM_TIMEOUT_MS = 150;
const IN_FLIGHT_MS = 400;
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

interface Setup {
  /** Troca o atendimento (ex.: para simular o banco fora antes de existir resposta). */
  readonly wrapAttendance?: (real: AttendanceService) => {
    handleInboundMessage: AttendanceService['handleInboundMessage'];
  };
  readonly queueRedisUrl?: string;
  readonly rateLimitWebhookMax?: number;
}

interface Harness {
  readonly app: FastifyInstance;
  readonly llm: MockLlmProvider;
  readonly logs: ReturnType<typeof captureLogs>;
  readonly metrics: ReturnType<typeof createMetrics>;
  readonly database: Database;
  readonly queue: InboundQueueHandle;
  readonly prefix: string;
  readonly messages: PrismaMessageRepository;
  stop(): Promise<void>;
}

async function start(setup: Setup = {}): Promise<Harness> {
  const logs = captureLogs();
  const metrics = createMetrics();
  const database = createDatabase(config, logs.logger);
  const redis = createRedis(config, logs.logger);
  const prefix = keyspace.scopedPrefix('bull').slice(0, -1);
  const queue = createInboundQueue({
    redisUrl: setup.queueRedisUrl ?? config.REDIS_URL,
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
    options: { llmTimeoutMs: LLM_TIMEOUT_MS, inFlightTimeoutMs: IN_FLIGHT_MS },
  });
  const processor = new ChannelInboundProcessor({
    attendance: setup.wrapAttendance?.(attendance) ?? attendance,
    clients,
    messages,
    sender: new WhatsappCloudApiClient({
      baseUrl: graph.baseUrl,
      graphApiVersion: VERSION,
      accessToken: ACCESS_TOKEN,
      timeoutMs: 300,
      metrics,
    }),
    logger: logs.logger,
  });
  queue.startWorker((job, context) => processor.process(job, context));
  const rateLimitRedis =
    setup.rateLimitWebhookMax === undefined ? undefined : createRateLimitRedis(config, logs.logger);
  // Sem a conexão pronta o limiter passaria em fail-open nas primeiras requisições.
  if (rateLimitRedis !== undefined) assert.ok(await rateLimitRedis.waitUntilReady(3_000));
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
    ...(rateLimitRedis === undefined || setup.rateLimitWebhookMax === undefined
      ? {}
      : {
          rateLimit: {
            redis: rateLimitRedis.client,
            profiles: {
              ...rateLimitProfilesFromConfig(config),
              webhook: { max: setup.rateLimitWebhookMax, windowSeconds: 60 },
            },
            keyPrefix: keyspace.scopedPrefix('ratelimit'),
          },
        }),
  });
  await app.ready();

  let stopped = false;
  return {
    app,
    llm,
    logs,
    metrics,
    database,
    queue,
    prefix,
    messages,
    async stop() {
      if (stopped) return;
      stopped = true;
      await app.close();
      await closeInfrastructure(
        { database, redis, rateLimitRedis, inboundQueue: queue },
        logs.logger,
      );
    },
  };
}

async function withHarness(fn: (h: Harness) => Promise<void>, setup: Setup = {}): Promise<void> {
  const h = await start(setup);
  try {
    await fn(h);
  } finally {
    await h.stop();
  }
}

/** Cliente com número do canal e persona própria. */
async function newClient(label: string, number: string | null = phoneNumberId()): Promise<Client> {
  const client = await tenants.createClient(label, number ?? undefined);
  await fixturesDb.prisma.client.updateMany({
    where: { id: client.id },
    data: { persona: `${PERSONA} ${label}` },
  });
  return client;
}

async function deliver(
  h: Harness,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const body = JSON.stringify(payload);
  return h.app.inject({
    method: 'POST',
    url: '/webhooks/whatsapp',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signWebhookBody(body, APP_SECRET),
      ...headers,
    },
    payload: body,
  });
}

function textEvent(number: string, contact: string, text: string, suffix = randomUUID()) {
  const id = fakeWamid(contact, `-${suffix}`);
  return {
    id,
    payload: webhookPayload([
      { phoneNumberId: number, profileName: PROFILE_NAME, messages: [{ id, from: contact, text }] },
    ]),
  };
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

/** Mensagens gravadas de (cliente, contato), em ordem cronológica. */
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

const bodyText = (request: { body: unknown }): string =>
  (request.body as { text: { body: string } }).text.body;

async function metricsBody(h: Harness): Promise<string> {
  const response = await h.app.inject({
    method: 'GET',
    url: '/metrics',
    headers: { authorization: `Bearer ${METRICS_TOKEN}` },
  });
  return response.body;
}

describe('canal WhatsApp: de ponta a ponta (webhook assinado, fila real, worker, mock, Graph falso)', () => {
  it('o servidor Graph recebe o envio certo; a conversa tem pergunta e resposta; a resposta fica com sentAt e channelMessageId', async () => {
    await withHarness(async (h) => {
      const number = phoneNumberId();
      const client = await newClient('e2e-ok', number);
      const contact = contactNumber();
      const { id, payload } = textEvent(number, contact, 'Qual o horário?');

      const response = await deliver(h, payload);
      assert.equal(response.statusCode, 200);

      await waitFor(
        async () => (await stored(client, contact)).some((m) => m.sentAt !== null),
        'resposta enviada',
      );
      assert.equal(graph.requests.length, 1);
      const [request] = graph.requests;
      assert.equal(request?.method, 'POST');
      assert.equal(request.path, `/${VERSION}/${number}/messages`);
      assert.equal(request.headers.authorization, `Bearer ${ACCESS_TOKEN}`);
      assert.equal((request.body as { to: string }).to, contact);
      assert.equal((request.body as { type: string }).type, 'text');
      assert.match(bodyText(request), /^\[mock\] Recebi: Qual o horário\?/);

      const messages = await stored(client, contact);
      assert.equal(messages.length, 2);
      const [user, reply] = messages;
      assert.equal(user?.role, 'USER');
      assert.equal(user.content, 'Qual o horário?');
      assert.equal(user.externalId, id);
      assert.equal(reply?.role, 'ASSISTANT');
      assert.equal(reply.content, bodyText(request));
      assert.equal(reply.replyToId, user.id);
      assert.ok(reply.sentAt instanceof Date);
      assert.equal(reply.channelMessageId, 'wamid.FAKE1');
    });
  });

  it('a resposta HTTP não espera o LLM: com o provider bloqueado em hold(), o webhook responde 200 e a resposta só sai depois', async (t) => {
    await withHarness(async (h) => {
      const number = phoneNumberId();
      const client = await newClient('e2e-hold', number);
      const contact = contactNumber();
      const release = h.llm.hold();
      t.after(release);

      const begin = Date.now();
      const response = await deliver(h, textEvent(number, contact, 'segura').payload);
      assert.equal(response.statusCode, 200);
      assert.ok(Date.now() - begin < 2_000);

      await waitFor(() => h.llm.calls.length === 1, 'LLM chamado pelo worker');
      assert.equal(graph.requests.length, 0, 'nada enviado enquanto o LLM está bloqueado');
      release();
      await waitFor(
        async () => (await stored(client, contact)).some((m) => m.sentAt !== null),
        'resposta enviada',
      );
    });
  });

  it('reentrega do mesmo evento (mesmo wamid) não gera segundo job nem segunda resposta', async () => {
    await withHarness(async (h) => {
      const number = phoneNumberId();
      const client = await newClient('e2e-dup', number);
      const contact = contactNumber();
      const { payload } = textEvent(number, contact, 'uma vez só');

      assert.equal((await deliver(h, payload)).statusCode, 200);
      assert.equal((await deliver(h, payload)).statusCode, 200);
      assert.equal((await deliver(h, payload)).statusCode, 200);
      await waitFor(
        async () => (await stored(client, contact)).some((m) => m.sentAt !== null),
        'resposta enviada',
      );
      await sleep(300);

      assert.equal(graph.requests.length, 1, 'um só envio');
      assert.equal(h.llm.calls.length, 1, 'um só atendimento');
      assert.equal((await stored(client, contact)).length, 2);
    });
  });

  it('retentativa depois de envio concluído (job reexecutado com outro jobId) não envia de novo', async () => {
    await withHarness(async (h) => {
      const number = phoneNumberId();
      const client = await newClient('e2e-rerun', number);
      const contact = contactNumber();
      const { id, payload } = textEvent(number, contact, 'reexecuta');
      await deliver(h, payload);
      await waitFor(
        async () => (await stored(client, contact)).some((m) => m.sentAt !== null),
        'resposta enviada',
      );

      const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
      const raw = new Queue(INBOUND_QUEUE_NAME, { connection, prefix: h.prefix });
      try {
        await raw.add(
          'text',
          {
            kind: 'text',
            clientId: client.id,
            phoneNumberId: number,
            contactRef: contact,
            text: 'reexecuta',
            externalId: id,
            requestId: 'req-reexecucao-1',
          },
          { jobId: `reexecucao-${randomUUID()}` },
        );
        await waitFor(
          async () => (await h.queue.jobCounts()).completed === 2,
          'segundo job concluído',
        );
      } finally {
        await raw.close();
        connection.disconnect();
      }
      assert.equal(graph.requests.length, 1, 'nenhum segundo envio');
      assert.equal(h.llm.calls.length, 1);
    });
  });
});

describe('canal WhatsApp: entrada e roteamento', () => {
  it('lote com vários números e clientes, e o MESMO contato escrevendo para dois clientes: conversas, histórico, persona e número separados', async () => {
    await withHarness(async (h) => {
      const numberA = phoneNumberId();
      const numberB = phoneNumberId();
      const a = await newClient('iso-a', numberA);
      const b = await newClient('iso-b', numberB);
      const contact = contactNumber();

      // Primeira rodada: um só lote com os dois números; depois mensagens intercaladas.
      const idA1 = fakeWamid(contact, '-a1');
      const idB1 = fakeWamid(contact, '-b1');
      const batch = webhookPayload([
        { phoneNumberId: numberA, messages: [{ id: idA1, from: contact, text: 'primeira de A' }] },
        { phoneNumberId: numberB, messages: [{ id: idB1, from: contact, text: 'primeira de B' }] },
      ]);
      assert.equal((await deliver(h, batch)).statusCode, 200);
      await waitFor(() => graph.requests.length === 2, 'duas respostas');

      const second = webhookPayload([
        {
          phoneNumberId: numberB,
          messages: [{ id: fakeWamid(contact, '-b2'), from: contact, text: 'segunda de B' }],
        },
        {
          phoneNumberId: numberA,
          messages: [{ id: fakeWamid(contact, '-a2'), from: contact, text: 'segunda de A' }],
        },
      ]);
      assert.equal((await deliver(h, second)).statusCode, 200);
      await waitFor(() => graph.requests.length === 4, 'quatro respostas');
      await waitFor(
        async () =>
          (await stored(a, contact)).filter((m) => m.sentAt !== null).length === 2 &&
          (await stored(b, contact)).filter((m) => m.sentAt !== null).length === 2,
        'marcas de envio',
      );

      // Cada resposta saiu pelo número do seu cliente (par número/destinatário do servidor falso).
      const pairs = graph.requests.map((request) => [
        request.phoneNumberId,
        bodyText(request).includes('de A'),
      ]);
      assert.deepEqual(pairs, [
        [numberA, true],
        [numberB, false],
        [numberB, false],
        [numberA, true],
      ]);
      // Conversas distintas, sem mistura.
      const convA = await fixturesDb.prisma.conversation.findMany({ where: { clientId: a.id } });
      const convB = await fixturesDb.prisma.conversation.findMany({ where: { clientId: b.id } });
      assert.equal(convA.length, 1);
      assert.equal(convB.length, 1);
      assert.notEqual(convA[0]?.id, convB[0]?.id);
      assert.ok((await stored(a, contact)).every((m) => !m.content.includes('de B')));
      assert.ok((await stored(b, contact)).every((m) => !m.content.includes('de A')));
      // Histórico enviado ao LLM sem mistura, e a persona de cada um só na sua conversa.
      for (const call of h.llm.calls) {
        const ofA = call.userMessage.includes('de A');
        const histories = call.history.map((turn) => turn.content).join('|');
        assert.ok(!histories.includes(ofA ? 'de B' : 'de A'), `histórico misturado: ${histories}`);
        assert.ok(call.systemPrompt.includes(ofA ? 'iso-a' : 'iso-b'));
        assert.ok(!call.systemPrompt.includes(ofA ? 'iso-b' : 'iso-a'));
      }
      assert.deepEqual(
        h.llm.calls.map((call) => call.history.length),
        [0, 0, 2, 2],
      );
    });
  });

  it('o mesmo wamid em dois clientes não colide (jobId e externalId são por cliente)', async () => {
    await withHarness(async (h) => {
      const numberA = phoneNumberId();
      const numberB = phoneNumberId();
      const a = await newClient('wamid-a', numberA);
      const b = await newClient('wamid-b', numberB);
      const contact = contactNumber();
      const sameId = fakeWamid(contact, `-igual-${randomUUID()}`);
      const payload = webhookPayload([
        {
          phoneNumberId: numberA,
          messages: [{ id: sameId, from: contact, text: 'mesmo id em A' }],
        },
        {
          phoneNumberId: numberB,
          messages: [{ id: sameId, from: contact, text: 'mesmo id em B' }],
        },
      ]);
      await deliver(h, payload);
      await waitFor(
        async () =>
          (await stored(a, contact)).some((m) => m.sentAt !== null) &&
          (await stored(b, contact)).some((m) => m.sentAt !== null),
        'as duas respostas',
      );
      assert.equal(graph.requests.length, 2);
      assert.equal((await stored(a, contact))[0]?.content, 'mesmo id em A');
      assert.equal((await stored(b, contact))[0]?.content, 'mesmo id em B');
    });
  });

  it('número desconhecido, cliente removido e cliente suspenso: 200, nada enfileirado, nada enviado, métrica e log warn', async () => {
    await withHarness(async (h) => {
      const suspendedNumber = phoneNumberId();
      const removedNumber = phoneNumberId();
      const suspended = await newClient('susp', suspendedNumber);
      await fixturesDb.prisma.client.updateMany({
        where: { id: suspended.id },
        data: { status: 'SUSPENDED' },
      });
      const removed = await newClient('removido', removedNumber);
      await fixturesDb.prisma.client.updateMany({
        where: { id: removed.id },
        data: { deletedAt: new Date() },
      });
      const contact = contactNumber();

      const payload = webhookPayload([
        {
          phoneNumberId: phoneNumberId(),
          messages: [{ id: fakeWamid(contact, '-1'), from: contact, text: 'sem dono' }],
        },
        {
          phoneNumberId: suspendedNumber,
          messages: [{ id: fakeWamid(contact, '-2'), from: contact, text: 'suspenso' }],
        },
        {
          phoneNumberId: removedNumber,
          messages: [{ id: fakeWamid(contact, '-3'), from: contact, text: 'removido' }],
        },
      ]);
      assert.equal((await deliver(h, payload)).statusCode, 200);
      await sleep(250);

      const counts = await h.queue.jobCounts();
      assert.deepEqual(
        [counts.waiting, counts.active, counts.delayed, counts.completed, counts.failed],
        [0, 0, 0, 0, 0],
      );
      assert.equal(graph.requests.length, 0);
      assert.equal(h.llm.calls.length, 0);
      assert.equal((await stored(suspended, contact)).length, 0);
      const body = await metricsBody(h);
      assert.match(
        body,
        /channel_inbound_messages_total\{channel="whatsapp",result="unknown_number"\} 2/,
      );
      assert.match(
        body,
        /channel_inbound_messages_total\{channel="whatsapp",result="client_unavailable"\} 1/,
      );
      assert.equal(h.logs.lines().filter((line) => line.level === 40).length >= 3, true);
    });
  });

  it('mensagem não textual e texto inválido: o contato recebe o texto constante; nada é gravado nem chama o LLM', async () => {
    await withHarness(async (h) => {
      const number = phoneNumberId();
      const client = await newClient('notice', number);
      const contact = contactNumber();
      const payload = webhookPayload([
        {
          phoneNumberId: number,
          messages: [
            { id: fakeWamid(contact, '-img'), from: contact, type: 'image' },
            { id: fakeWamid(contact, '-vazio'), from: contact, text: '   ' },
            { id: fakeWamid(contact, '-grande'), from: contact, text: 'x'.repeat(4001) },
          ],
        },
      ]);
      assert.equal((await deliver(h, payload)).statusCode, 200);
      await waitFor(() => graph.requests.length === 3, 'três avisos');

      assert.deepEqual(graph.requests.map(bodyText), [
        CHANNEL_NOTICE_TEXTS.unsupported_type,
        CHANNEL_NOTICE_TEXTS.invalid_text,
        CHANNEL_NOTICE_TEXTS.invalid_text,
      ]);
      assert.ok(graph.requests.every((request) => request.phoneNumberId === number));
      assert.equal((await stored(client, contact)).length, 0);
      assert.equal(h.llm.calls.length, 0);
    });
  });

  it('reação e evento system não geram job nem envio; áudio e imagem seguem gerando o aviso', async () => {
    await withHarness(async (h) => {
      const number = phoneNumberId();
      const client = await newClient('ignored', number);
      const contact = contactNumber();
      const ignoredPayload = webhookPayload([
        {
          phoneNumberId: number,
          messages: [
            {
              id: fakeWamid(contact, '-reacao'),
              from: contact,
              type: 'reaction',
              extra: { reaction: { emoji: 'x' } },
            },
            {
              id: fakeWamid(contact, '-sistema'),
              type: 'system',
              extra: { system: { body: 'mudou' } },
            },
          ],
        },
      ]);
      assert.equal((await deliver(h, ignoredPayload)).statusCode, 200);
      await sleep(250);
      const counts = await h.queue.jobCounts();
      assert.equal((counts.waiting ?? 0) + (counts.completed ?? 0) + (counts.failed ?? 0), 0);
      assert.equal(graph.requests.length, 0);
      assert.equal(h.llm.calls.length, 0);
      assert.equal((await stored(client, contact)).length, 0);
      assert.match(
        await metricsBody(h),
        /channel_inbound_messages_total\{channel="whatsapp",result="ignored_type"\} 2/,
      );

      const noticePayload = webhookPayload([
        {
          phoneNumberId: number,
          messages: [
            { id: fakeWamid(contact, '-audio'), from: contact, type: 'audio' },
            { id: fakeWamid(contact, '-imagem'), from: contact, type: 'image' },
          ],
        },
      ]);
      assert.equal((await deliver(h, noticePayload)).statusCode, 200);
      await waitFor(() => graph.requests.length === 2, 'dois avisos');
      assert.ok(
        graph.requests.every(
          (request) => bodyText(request) === CHANNEL_NOTICE_TEXTS.unsupported_type,
        ),
      );
    });
  });

  it('statuses não geram job nem resposta; failed loga warn e só conta', async () => {
    await withHarness(async (h) => {
      const number = phoneNumberId();
      await newClient('status', number);
      const contact = contactNumber();
      const payload = webhookPayload([
        {
          phoneNumberId: number,
          statuses: [
            { id: fakeWamid(contact, '-out'), status: 'delivered', recipientId: contact },
            {
              id: fakeWamid(contact, '-out'),
              status: 'failed',
              recipientId: contact,
              errorCode: 131049,
            },
          ],
        },
      ]);
      assert.equal((await deliver(h, payload)).statusCode, 200);
      await sleep(200);
      assert.equal(graph.requests.length, 0);
      const counts = await h.queue.jobCounts();
      assert.equal((counts.waiting ?? 0) + (counts.completed ?? 0) + (counts.failed ?? 0), 0);
      assert.ok(h.logs.lines().some((line) => line.errorCode === 131049 && line.level === 40));
    });
  });

  it('o clientId nunca vem de fora: cabeçalho, query e corpo apontando para outro cliente são ignorados', async () => {
    await withHarness(async (h) => {
      const number = phoneNumberId();
      const owner = await newClient('dono', number);
      const other = await newClient('outro');
      const contact = contactNumber();
      const { payload } = textEvent(number, contact, 'quem sou eu');
      const body = JSON.stringify({ ...payload, clientId: other.id });
      const response = await h.app.inject({
        method: 'POST',
        url: `/webhooks/whatsapp?clientId=${other.id}`,
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': signWebhookBody(body, APP_SECRET),
          'x-client-id': other.id,
        },
        payload: body,
      });
      assert.equal(response.statusCode, 200);
      await waitFor(
        async () => (await stored(owner, contact)).some((m) => m.sentAt !== null),
        'resposta',
      );
      assert.equal((await stored(other, contact)).length, 0);
      assert.equal(graph.requests[0]?.phoneNumberId, number);
    });
  });
});

describe('canal WhatsApp: falhas e retentativas', () => {
  it('falha transitória do Graph (500, 429, timeout) é retentada com backoff e termina em um só envio bem-sucedido e uma só resposta', async (t) => {
    const release = keepEventLoopAlive();
    t.after(release);
    await withHarness(async (h) => {
      const number = phoneNumberId();
      const client = await newClient('retry', number);
      const contact = contactNumber();
      graph.script(
        { kind: 'respond', status: 500, body: { error: { code: 1, type: 'OAuthException' } } },
        graphError(429, 130429),
        { kind: 'hang' },
      );

      await deliver(h, textEvent(number, contact, 'tente de novo').payload);
      await waitFor(
        async () => (await stored(client, contact)).some((m) => m.sentAt !== null),
        'envio concluído',
        20_000,
      );

      assert.equal(graph.requests.length, 4, 'três falhas e um sucesso');
      assert.equal(graph.successCount, 1, 'um só envio bem-sucedido');
      assert.equal(h.llm.calls.length, 1, 'o LLM foi chamado uma vez');
      const messages = await stored(client, contact);
      assert.equal(messages.length, 2, 'uma só resposta gravada');
      assert.equal(messages[1]?.channelMessageId, 'wamid.FAKE1');
      assert.ok(
        graph.requests.every(
          (request) => bodyText(request) === bodyText(graph.requests[0] ?? { body: {} }),
        ),
      );
      const body = await metricsBody(h);
      assert.match(body, /channel_send_total\{channel="whatsapp",result="error"\} 3/);
      assert.match(body, /channel_send_total\{channel="whatsapp",result="ok"\} 1/);
      assert.match(body, /queue_jobs_total\{queue="channel-inbound",result="retried"\} 3/);
    });
  });

  it('falha permanente (token inválido, janela fechada): sem retentativa, resposta gravada sem sentAt, métrica error', async () => {
    await withHarness(async (h) => {
      for (const code of [190, 131047]) {
        graph.reset();
        const number = phoneNumberId();
        const client = await newClient(`perm-${String(code)}`, number);
        const contact = contactNumber();
        graph.always(graphError(code === 190 ? 401 : 400, code));

        await deliver(h, textEvent(number, contact, 'permanente').payload);
        await waitFor(async () => (await stored(client, contact)).length === 2, 'resposta gravada');
        await waitFor(
          async () => (await h.queue.jobCounts()).failed === (code === 190 ? 1 : 2),
          'job falho',
        );
        await sleep(350);

        assert.equal(graph.requests.length, 1, `código ${String(code)}: uma só tentativa`);
        const messages = await stored(client, contact);
        assert.equal(messages[1]?.sentAt, null);
        assert.equal(messages[1].channelMessageId, null);
        const line = h.logs
          .lines()
          .find(
            (entry) =>
              entry.providerCode === code &&
              entry.msg === 'envio recusado de forma permanente; sem retentativa',
          );
        assert.equal(line?.clientId, client.id);
      }
      assert.match(
        await metricsBody(h),
        /channel_send_total\{channel="whatsapp",result="error"\} 2/,
      );
    });
  });

  it('erro do service antes de existir resposta (banco fora simulado) esgota as tentativas e o contato recebe o texto padrão; se esse envio falha, só loga', async () => {
    await withHarness(
      async (h) => {
        const number = phoneNumberId();
        const client = await newClient('db-down', number);
        const contact = contactNumber();

        await deliver(h, textEvent(number, contact, 'FALHA-BANCO simulada').payload);
        await waitFor(() => graph.requests.length === 1, 'texto padrão enviado', 20_000);
        assert.equal(bodyText(graph.requests[0] ?? { body: {} }), ATTENDANCE_FALLBACK_TEXT);
        assert.equal(graph.requests[0]?.phoneNumberId, number);
        await waitFor(async () => (await h.queue.jobCounts()).failed === 1, 'job falho');
        assert.equal(h.llm.calls.length, 0);
        assert.equal((await stored(client, contact)).length, 0, 'nada gravado');

        // Segundo contato: o envio do texto padrão também falha (permanente) e só gera log.
        graph.reset();
        graph.always(graphError(401, 190));
        const second = contactNumber();
        await deliver(h, textEvent(number, second, 'FALHA-BANCO de novo').payload);
        await waitFor(
          async () => (await h.queue.jobCounts()).failed === 2,
          'segundo job falho',
          20_000,
        );
        assert.equal(graph.requests.length, 1, 'uma única tentativa do texto padrão');
        assert.ok(
          h.logs.lines().some((line) => line.msg === 'falha ao enviar o texto padrão ao contato'),
        );
      },
      {
        wrapAttendance: (real) => ({
          handleInboundMessage: (clientId, input) =>
            input.text.includes('FALHA-BANCO')
              ? Promise.reject(new DatabaseError('banco indisponível simulado'))
              : real.handleInboundMessage(clientId, input),
        }),
      },
    );
  });

  it('LLM com falha ou timeout: o fallback é gravado E enviado ao contato', async (t) => {
    const release = keepEventLoopAlive();
    t.after(release);
    await withHarness(async (h) => {
      const number = phoneNumberId();
      const client = await newClient('llm-fail', number);
      for (const marker of [MOCK_FAIL_MARKER, MOCK_HANG_MARKER]) {
        graph.reset();
        const contact = contactNumber();
        await deliver(h, textEvent(number, contact, `oi ${marker}`).payload);
        await waitFor(
          async () => (await stored(client, contact)).some((m) => m.sentAt !== null),
          `fallback enviado (${marker})`,
        );
        assert.equal(graph.requests.length, 1);
        assert.equal(bodyText(graph.requests[0] ?? { body: {} }), ATTENDANCE_FALLBACK_TEXT);
        const messages = await stored(client, contact);
        assert.equal(messages[1]?.isFallback, true);
      }
    });
  });

  it('ConflictError (mensagem em andamento) é retentado e, passado o prazo, completa sem segunda chamada ao LLM', async () => {
    await withHarness(async (h) => {
      const number = phoneNumberId();
      const client = await newClient('conflict', number);
      const contact = contactNumber();
      const { id, payload } = textEvent(number, contact, 'já em andamento');
      // Mensagem do contato gravada agora e ainda sem resposta: "em andamento" por IN_FLIGHT_MS.
      const conversation = await fixturesDb.prisma.conversation.create({
        data: { clientId: client.id, contactRef: contact },
      });
      await fixturesDb.prisma.message.create({
        data: {
          clientId: client.id,
          conversationId: conversation.id,
          role: 'USER',
          content: 'já em andamento',
          externalId: id,
        },
      });

      await deliver(h, payload);
      await waitFor(
        async () =>
          (await h.queue.jobCounts()).delayed === 1 ||
          h.logs.lines().some((l) => l.msg === 'job falhou; será retentado com backoff'),
        'primeira tentativa em 409',
      );
      assert.equal(h.llm.calls.length, 0, 'a mensagem ainda estava viva: nenhuma chamada ao LLM');

      await waitFor(
        async () => (await stored(client, contact)).some((m) => m.sentAt !== null),
        'retentativa concluída',
        20_000,
      );
      assert.equal(h.llm.calls.length, 1, 'uma só chamada ao LLM');
      assert.equal(graph.requests.length, 1);
      assert.equal((await stored(client, contact)).length, 2);
    });
  });

  it('job adulterado: o envio usa o número do cliente no banco, não o do payload do job', async () => {
    await withHarness(async (h) => {
      const number = phoneNumberId();
      const otherNumber = phoneNumberId();
      const client = await newClient('forged', number);
      await newClient('forged-other', otherNumber);
      const contact = contactNumber();
      const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
      const raw = new Queue(INBOUND_QUEUE_NAME, { connection, prefix: h.prefix });
      try {
        await raw.add('text', {
          kind: 'text',
          clientId: client.id,
          phoneNumberId: number,
          contactRef: contact,
          text: 'job adulterado',
          externalId: fakeWamid(contact, '-forjado'),
          requestId: 'req-forjado-123',
          // Campos extras que um adulterador poderia tentar usar para escolher o número de envio.
          phone_number_id: otherNumber,
          sendFrom: otherNumber,
        });
        await waitFor(() => graph.requests.length === 1, 'envio');
        // Job cujo phoneNumberId não é o do cliente no banco: descartado, nada sai por número algum.
        const before = graph.requests.length;
        await raw.add('text', {
          kind: 'text',
          clientId: client.id,
          phoneNumberId: otherNumber,
          contactRef: contact,
          text: 'job com outro número',
          externalId: fakeWamid(contact, '-forjado-2'),
          requestId: 'req-forjado-456',
        });
        await waitFor(async () => (await h.queue.jobCounts()).failed === 1, 'job descartado');
        assert.equal(graph.requests.length, before, 'nada enviado pelo job com outro número');
      } finally {
        await raw.close();
        connection.disconnect();
      }
      assert.equal(graph.requests[0]?.phoneNumberId, number);
      assert.notEqual(graph.requests[0].phoneNumberId, otherNumber);
    });
  });
});

describe('canal WhatsApp: Redis fora e encerramento', () => {
  it('Redis fora ao enfileirar: 500 para a Meta retentar; a reentrega, com a fila de volta, enfileira só o que faltou', async (t) => {
    const release = keepEventLoopAlive();
    t.after(release);
    const number = phoneNumberId();
    const client = await newClient('redis-down', number);
    const contact = contactNumber();
    const { payload } = textEvent(number, contact, 'redis fora');

    const down = await start({ queueRedisUrl: withPort(config.REDIS_URL, await getClosedPort()) });
    try {
      const response = await deliver(down, payload);
      assert.equal(response.statusCode, 500);
      assert.equal(response.json<{ error: { code: string } }>().error.code, 'ENQUEUE_FAILED');
      assert.equal(graph.requests.length, 0);
      assert.equal((await stored(client, contact)).length, 0);
      assert.match(
        await metricsBody(down),
        /webhook_requests_total\{channel="whatsapp",result="enqueue_failed"\} 1/,
      );
    } finally {
      await down.stop();
    }

    await withHarness(async (h) => {
      assert.equal((await deliver(h, payload)).statusCode, 200);
      await waitFor(
        async () => (await stored(client, contact)).some((m) => m.sentAt !== null),
        'resposta',
      );
      assert.equal(graph.requests.length, 1);
    });
  });

  it('encerramento do processo: espera o job ativo terminar (resposta enviada e marcada) antes de fechar o banco e o Redis', async () => {
    const h = await start();
    try {
      const number = phoneNumberId();
      const client = await newClient('shutdown', number);
      const contact = contactNumber();
      graph.always({
        kind: 'respond',
        status: 200,
        delayMs: 200,
        body: { messages: [{ id: 'wamid.LENTO' }] },
      });

      await deliver(h, textEvent(number, contact, 'encerra no meio').payload);
      await waitFor(() => graph.requests.length === 1, 'envio em andamento no Graph');

      // Encerra enquanto o envio ainda não respondeu: o job está ativo.
      await h.stop();

      const messages = await stored(client, contact);
      const reply = messages.find((m) => m.role === 'ASSISTANT');
      assert.ok(
        reply?.sentAt instanceof Date,
        'o job ativo terminou e gravou a marca antes de o banco fechar',
      );
      assert.equal(reply.channelMessageId, 'wamid.LENTO');
      assert.ok(
        !h.logs
          .lines()
          .some((line) => Number(line.level) >= 50 && String(line.msg).includes('marca de envio')),
      );
    } finally {
      await h.stop();
    }
  });
});

describe('canal WhatsApp: rate limit, métricas e privacidade', () => {
  it('o webhook usa o perfil webhook do rate limit: acima do limite, 429 antes de ler o corpo e de conferir a assinatura', async () => {
    await withHarness(
      async (h) => {
        const number = phoneNumberId();
        await newClient('rl', number);
        const unsigned = (): Promise<{ statusCode: number }> =>
          h.app.inject({
            method: 'POST',
            url: '/webhooks/whatsapp',
            headers: { 'content-type': 'application/json' },
            payload: '{}',
          });
        assert.equal((await unsigned()).statusCode, 401);
        assert.equal((await unsigned()).statusCode, 401);
        // O GET também conta no mesmo perfil.
        const third = await h.app.inject({
          method: 'GET',
          url: '/webhooks/whatsapp?hub.mode=subscribe',
        });
        assert.equal(third.statusCode, 403);
        const limited = await unsigned();
        assert.equal(limited.statusCode, 429);
        assert.match(await metricsBody(h), /rate_limit_rejected_total\{profile="webhook"\} 1/);
        assert.equal(graph.requests.length, 0);
      },
      { rateLimitWebhookMax: 3 },
    );
  });

  it('as métricas do canal aparecem em /metrics, sem clientId, telefone nem texto em label', async () => {
    await withHarness(async (h) => {
      const number = phoneNumberId();
      const client = await newClient('metrics', number);
      const contact = contactNumber();
      await deliver(h, textEvent(number, contact, SECRET_FOR_METRICS).payload);
      await waitFor(
        async () => (await stored(client, contact)).some((m) => m.sentAt !== null),
        'resposta',
      );
      await deliver(
        h,
        webhookPayload([
          { phoneNumberId: number, statuses: [{ id: 'wamid.s', status: 'delivered' }] },
        ]),
      );
      await waitFor(async () => (await h.queue.jobCounts()).completed === 1, 'job concluído');

      const body = await metricsBody(h);
      for (const name of [
        'webhook_requests_total{channel="whatsapp",result="ok"}',
        'channel_inbound_messages_total{channel="whatsapp",result="enqueued"}',
        'channel_status_events_total{channel="whatsapp",status="delivered"}',
        'channel_send_total{channel="whatsapp",result="ok"}',
        'channel_send_duration_seconds_count{channel="whatsapp"}',
        'queue_jobs_total{queue="channel-inbound",result="completed"}',
      ]) {
        assert.ok(body.includes(name), `ausente em /metrics: ${name}`);
      }
      for (const secret of [client.id, number, contact, SECRET_FOR_METRICS]) {
        assert.ok(!body.includes(secret), `vazou em /metrics: ${secret}`);
      }
    });
  });

  it('texto, contato, destinatário, nome de perfil, persona, wamid e os três segredos não aparecem em nenhuma linha de log (sucesso, falhas, descartes)', async (t) => {
    const release = keepEventLoopAlive();
    t.after(release);
    await withHarness(
      async (h) => {
        const number = phoneNumberId();
        const client = await newClient('privacy', number);
        const contact = contactNumber();
        const secretText = 'texto-secreto-do-e2e-31c';
        const ids: string[] = [];
        const send = async (text: string): Promise<void> => {
          const event = textEvent(number, contact, text);
          ids.push(event.id);
          assert.equal((await deliver(h, event.payload)).statusCode, 200);
        };

        // Sucesso.
        await send(secretText);
        await waitFor(
          async () => (await stored(client, contact)).some((m) => m.sentAt !== null),
          'sucesso',
        );
        // Falha transitória seguida de sucesso.
        graph.failNext(1, graphError(500, 1));
        await send(`${secretText} 2`);
        await waitFor(() => graph.successCount === 2, 'retentativa');
        // Falha permanente do envio, fallback do LLM e timeout do LLM.
        graph.failNext(1, graphError(401, 190));
        await send(`${secretText} 3`);
        await waitFor(async () => (await h.queue.jobCounts()).failed === 1, 'permanente');
        await send(`${secretText} ${MOCK_FAIL_MARKER}`);
        await send(`${secretText} ${MOCK_HANG_MARKER}`);
        // Banco fora antes da resposta, aviso, assinatura inválida, JSON inválido, número desconhecido.
        await send(`${secretText} FALHA-BANCO`);
        await waitFor(async () => (await h.queue.jobCounts()).failed === 2, 'banco fora', 20_000);
        await deliver(
          h,
          webhookPayload([
            {
              phoneNumberId: number,
              messages: [{ id: fakeWamid(contact, '-img'), from: contact, type: 'image' }],
            },
          ]),
        );
        await h.app.inject({
          method: 'POST',
          url: '/webhooks/whatsapp',
          headers: {
            'content-type': 'application/json',
            'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
          },
          payload: textEvent(number, contact, secretText).payload,
        });
        await h.app.inject({
          method: 'POST',
          url: '/webhooks/whatsapp',
          headers: {
            'content-type': 'application/json',
            'x-hub-signature-256': signWebhookBody('{x', APP_SECRET),
          },
          payload: '{x',
        });
        await deliver(h, textEvent(phoneNumberId(), contact, secretText).payload);
        await h.app.inject({
          method: 'GET',
          url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=555`,
        });
        await sleep(1_500);

        const raw = h.logs.raw();
        assert.ok(raw.length > 0);
        for (const secret of [
          secretText,
          contact,
          PROFILE_NAME,
          PERSONA,
          APP_SECRET,
          VERIFY_TOKEN,
          ACCESS_TOKEN,
          Buffer.from(`\u001c\u0018\u000b${contact}`).toString('base64'),
          ...ids,
        ]) {
          assert.ok(!raw.includes(secret), `vazou em log: ${secret}`);
        }
        // Todo log do worker leva o clientId do job (contexto aberto pelo worker).
        const attendance = h.logs.lines().filter((line) => line.msg === 'mensagem atendida');
        assert.ok(attendance.length >= 1);
        assert.ok(attendance.every((line) => line.clientId === client.id));
      },
      {
        wrapAttendance: (real) => ({
          handleInboundMessage: (clientId, input) =>
            input.text.includes('FALHA-BANCO')
              ? Promise.reject(new DatabaseError('banco indisponível simulado'))
              : real.handleInboundMessage(clientId, input),
        }),
      },
    );
  });

  it('jobs de dois clientes em sequência mantêm cada um o seu clientId nos logs do worker', async () => {
    await withHarness(async (h) => {
      const numberA = phoneNumberId();
      const numberB = phoneNumberId();
      const a = await newClient('log-a', numberA);
      const b = await newClient('log-b', numberB);
      const contact = contactNumber();
      const payload = webhookPayload([
        {
          phoneNumberId: numberA,
          messages: [{ id: fakeWamid(contact, '-la'), from: contact, text: 'log A' }],
        },
        {
          phoneNumberId: numberB,
          messages: [{ id: fakeWamid(contact, '-lb'), from: contact, text: 'log B' }],
        },
      ]);
      await deliver(h, payload);
      await waitFor(() => graph.requests.length === 2, 'duas respostas');
      await waitFor(async () => (await h.queue.jobCounts()).completed === 2, 'jobs concluídos');
      const sent = h.logs.lines().filter((line) => line.msg === 'resposta enviada ao contato');
      assert.deepEqual(
        sent.map((line) => line.clientId),
        [a.id, b.id],
      );
      const attended = h.logs.lines().filter((line) => line.msg === 'mensagem atendida');
      assert.deepEqual(
        attended.map((line) => line.clientId),
        [a.id, b.id],
      );
    });
  });
});

const SECRET_FOR_METRICS = 'texto-secreto-para-metricas-88';
