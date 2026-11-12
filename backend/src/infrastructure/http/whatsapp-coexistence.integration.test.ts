import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { AttendanceService } from '../../application/attendance/attendance.service.js';
import {
  type ChannelBatchSettings,
  ChannelInboundProcessor,
} from '../../application/channel/channel-inbound.processor.js';
import { ChannelIntakeService } from '../../application/channel/channel-intake.service.js';
import type { Company } from '../../domain/index.js';
import { Result } from '../../shared/types/index.js';
import { FakeGraphApi } from '../../test-support/fake-graph-api.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { buildChannelCredentials } from '../../test-support/channel-credentials.js';
import { captureLogs, logContains } from '../../test-support/log-capture.js';
import { TestKeyspace } from '../../test-support/test-keyspace.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import {
  echoWebhookPayload,
  fakeWamid,
  signWebhookBody,
  webhookPayload,
} from '../../test-support/whatsapp-payloads.js';
import { createRedis } from '../cache/redis.client.js';
import {
  createDatabase,
  type Database,
  PrismaAttendanceUnitOfWork,
  PrismaCompanyRepository,
  PrismaConversationRepository,
  PrismaMessageRepository,
} from '../database/index.js';
import { MockLlmProvider } from '../external-apis/llm/mock-llm.provider.js';
import { WhatsappCloudApiClient } from '../external-apis/whatsapp/whatsapp-cloud-api.client.js';
import { closeInfrastructure } from '../lifecycle.js';
import { createMetrics } from '../metrics/index.js';
import { createInboundQueue, type InboundQueueHandle } from '../queue/inbound-queue.js';
import { buildServer } from './server.js';

// Falha aqui (antes de abrir qualquer conexão) se o ambiente não for o de testes (soprei_test, Redis /15).
const config = loadIntegrationConfig();

const APP_SECRET = `app-secret-${randomUUID()}`;
const VERIFY_TOKEN = `verify-token-${randomUUID()}`;
const ACCESS_TOKEN = `EAAG-access-${randomUUID()}`;
const METRICS_TOKEN = `metrics-${randomUUID()}-${randomUUID()}`;
const PERSONA = 'persona-secreta-coex';
const SECRET_TEXT = 'texto-secreto-do-contato-coex-039';
const SECRET_TEAM = 'texto-secreto-da-equipe-coex-039';
const QUEUE_SETTINGS: {
  attempts: number;
  backoffMs: number;
  keepCompletedSeconds: number;
  keepFailedSeconds: number;
  concurrency?: number;
} = {
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
  readonly metrics: ReturnType<typeof createMetrics>;
  stop(): Promise<void>;
}

async function start(
  batch: ChannelBatchSettings,
  queueSettings: typeof QUEUE_SETTINGS = QUEUE_SETTINGS,
): Promise<Harness> {
  const logs = captureLogs();
  const metrics = createMetrics();
  const database = createDatabase(config, logs.logger);
  const redis = createRedis(config, logs.logger);
  const prefix = keyspace.scopedPrefix('bull').slice(0, -1);
  const queue = createInboundQueue({
    redisUrl: config.REDIS_URL,
    settings: queueSettings,
    logger: logs.logger,
    metrics,
    prefix,
    enqueueTimeoutMs: 800,
  });
  const llm = new MockLlmProvider({ recordCalls: true });
  const { prisma } = database;
  const companies = new PrismaCompanyRepository(prisma);
  const messages = new PrismaMessageRepository(prisma);
  const attendance = new AttendanceService({
    companies,
    conversations: new PrismaConversationRepository(prisma),
    messages,
    unitOfWork: new PrismaAttendanceUnitOfWork(prisma),
    llm,
    logger: logs.logger,
    metrics,
    options: { llmTimeoutMs: 5_000, inFlightTimeoutMs: 60_000 },
  });
  const stack = buildChannelCredentials(prisma, { legacyToken: ACCESS_TOKEN, metrics });
  const processor = new ChannelInboundProcessor({
    attendance,
    companies,
    messages,
    // Empresas de teste só têm número (sem conexão): são `LEGACY` e usam o token global.
    credentials: stack.credentials,
    connections: stack.connections,
    sender: new WhatsappCloudApiClient({
      baseUrl: graph.baseUrl,
      graphApiVersion: VERSION,
      timeoutMs: 1_000,
      metrics,
    }),
    queue: queue.queue,
    batch,
    logger: logs.logger,
    metrics,
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
        companies,
        queue: queue.queue,
        logger: logs.logger,
        metrics,
        channel: 'whatsapp',
      }),
      echoesEnabled: true,
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
    metrics,
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
  queueSettings: typeof QUEUE_SETTINGS = QUEUE_SETTINGS,
): Promise<void> {
  const h = await start(
    {
      windowMs: 1_500,
      maxWaitMs: 6_000,
      maxMessages: 10,
      maxChars: 8_000,
      ...batch,
    },
    queueSettings,
  );
  try {
    await fn(h);
  } finally {
    await h.stop();
  }
}

async function newCompany(label: string, number: string): Promise<Company> {
  const company = await tenants.createCompany(label, number);
  await fixturesDb.prisma.company.updateMany({
    where: { id: company.id },
    data: { persona: `${PERSONA} ${label}` },
  });
  return company;
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

async function stored(company: Company, contact: string) {
  const conversation = await fixturesDb.prisma.conversation.findFirst({
    where: { companyId: company.id, contactRef: contact },
  });
  if (conversation === null) return [];
  return fixturesDb.prisma.message.findMany({
    where: { companyId: company.id, conversationId: conversation.id },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

const sentCount = async (company: Company, contact: string): Promise<number> =>
  (await stored(company, contact)).filter((m) => m.role === 'ASSISTANT' && m.sentAt !== null)
    .length;
const userCount = async (company: Company, contact: string): Promise<number> =>
  (await stored(company, contact)).filter((m) => m.role === 'USER').length;

/** A equipe responde pelo aplicativo: webhook `smb_message_echoes` assinado. Devolve o id do eco. */
async function echo(
  h: Harness,
  number: string,
  contact: string,
  text = SECRET_TEAM,
): Promise<string> {
  const id = fakeWamid(contact, `-ECO-${randomUUID()}`);
  const body = JSON.stringify(echoWebhookPayload(number, [{ id, to: contact, text }]));
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

async function conversationRow(company: Company, contact: string) {
  return fixturesDb.prisma.conversation.findFirst({
    where: { companyId: company.id, contactRef: contact },
  });
}

const humanCount = async (company: Company, contact: string): Promise<number> =>
  (await stored(company, contact)).filter((m) => m.role === 'HUMAN').length;
const assistantCount = async (company: Company, contact: string): Promise<number> =>
  (await stored(company, contact)).filter((m) => m.role === 'ASSISTANT').length;

/** A mensagem mais nova do contato já saiu das pendentes (o turno pausado a tratou)? */
async function ignoredUpToLastUser(company: Company, contact: string): Promise<boolean> {
  const conversation = await conversationRow(company, contact);
  const lastUser = (await stored(company, contact)).filter((m) => m.role === 'USER').at(-1);
  return (
    conversation?.aiIgnoreBefore != null &&
    lastUser !== undefined &&
    lastUser.createdAt.getTime() <= conversation.aiIgnoreBefore.getTime()
  );
}

describe('coexistência no canal (spec 039, E3; webhook, BullMQ, Postgres e Graph falso reais)', () => {
  it('eco grava uma HUMAN e pausa; o que o contato escreve depois não chama o LLM nem é enviado', async () => {
    await withHarness({ windowMs: 200, maxWaitMs: 1_000 }, async (h) => {
      const number = phoneNumberId();
      const company = await newCompany('coex-pausa', number);
      const contact = contactNumber();

      await echo(h, number, contact);
      await waitFor(async () => (await humanCount(company, contact)) === 1, 'eco gravado');
      const conversation = await conversationRow(company, contact);
      assert.ok(conversation?.aiPausedUntil != null);
      const human = (await stored(company, contact)).find((m) => m.role === 'HUMAN');
      assert.equal(
        conversation.aiPausedUntil.getTime() - (human?.createdAt.getTime() ?? 0),
        12 * 60 * 60 * 1000,
      );

      await send(h, number, contact, SECRET_TEXT);
      await waitFor(() => ignoredUpToLastUser(company, contact), 'turno pausado');

      assert.equal(h.llm.calls.length, 0);
      assert.equal(graph.requests.length, 0, 'nada enviado ao contato');
      assert.equal(await assistantCount(company, contact), 0);
      assert.equal(await userCount(company, contact), 1, 'a mensagem do contato não se perde');
      assert.match(await h.metrics.render(), /channel_echo_events_total{result="recorded"} 1/);
    });
  });

  it('reentrega do mesmo eco não duplica a HUMAN', async () => {
    await withHarness({ windowMs: 200, maxWaitMs: 1_000 }, async (h) => {
      const number = phoneNumberId();
      const company = await newCompany('coex-dup', number);
      const contact = contactNumber();
      const id = fakeWamid(contact, '-ECO-FIXO');
      const body = JSON.stringify(echoWebhookPayload(number, [{ id, to: contact, text: 'oi' }]));
      for (let i = 0; i < 2; i += 1) {
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
        await waitFor(async () => (await humanCount(company, contact)) === 1, 'eco gravado');
      }
      await sleep(300);
      assert.equal(await humanCount(company, contact), 1);
    });
  });

  it('corrida: eco com o flush agendado (dentro da janela) impede a resposta', async () => {
    await withHarness({ windowMs: 1_000, maxWaitMs: 3_000 }, async (h) => {
      const number = phoneNumberId();
      const company = await newCompany('coex-agendado', number);
      const contact = contactNumber();

      await send(h, number, contact, SECRET_TEXT);
      await waitFor(async () => (await userCount(company, contact)) === 1, 'mensagem aceita');
      await echo(h, number, contact);
      await waitFor(async () => (await humanCount(company, contact)) === 1, 'eco gravado');
      await sleep(1_600);

      assert.equal(h.llm.calls.length, 0);
      assert.equal(graph.requests.length, 0);
      assert.equal(await assistantCount(company, contact), 0);
      assert.equal(await userCount(company, contact), 1);
    });
  });

  it('corrida: eco durante a chamada ao LLM desfaz a resposta (nada gravado da IA, nada enviado)', async () => {
    // Concorrência 4 (como em produção, spec 034): o eco roda enquanto o flush espera o modelo.
    await withHarness(
      { windowMs: 100, maxWaitMs: 500 },
      async (h) => {
        const number = phoneNumberId();
        const company = await newCompany('coex-llm', number);
        const contact = contactNumber();
        const release = h.llm.hold();
        try {
          await send(h, number, contact, SECRET_TEXT);
          await waitFor(() => h.llm.calls.length === 1, 'turno chegou ao modelo');
          await echo(h, number, contact);
          await waitFor(async () => (await humanCount(company, contact)) === 1, 'eco gravado');
        } finally {
          release();
        }
        await waitFor(() => ignoredUpToLastUser(company, contact), 'turno desfeito como pausado');
        await sleep(300);

        assert.equal(await assistantCount(company, contact), 0);
        assert.equal(graph.requests.length, 0);
        assert.equal(await userCount(company, contact), 1);
        assert.equal(await humanCount(company, contact), 1);
      },
      { ...QUEUE_SETTINGS, concurrency: 4 },
    );
  });

  it('ordem por receivedAt: contato, equipe, contato; isolamento A x B e número desconhecido', async () => {
    await withHarness({ windowMs: 200, maxWaitMs: 1_000 }, async (h) => {
      const numberA = phoneNumberId();
      const numberB = phoneNumberId();
      const companyA = await newCompany('coex-ordem-a', numberA);
      const companyB = await newCompany('coex-ordem-b', numberB);
      const contact = contactNumber();

      await send(h, numberB, contact, 'oi B');
      await waitFor(async () => (await sentCount(companyB, contact)) === 1, 'B respondeu');

      await send(h, numberA, contact, 'primeira');
      await sleep(20);
      await echo(h, numberA, contact);
      await sleep(20);
      await send(h, numberA, contact, 'segunda');
      await waitFor(async () => (await humanCount(companyA, contact)) === 1, 'eco gravado');
      await waitFor(async () => (await userCount(companyA, contact)) === 2, 'mensagens aceitas');
      const rolesA = (await stored(companyA, contact)).map((m) => m.role);
      assert.deepEqual(rolesA, ['USER', 'HUMAN', 'USER']);

      // A B não foi tocada pelo eco da A.
      assert.equal(await humanCount(companyB, contact), 0);
      assert.equal((await conversationRow(companyB, contact))?.aiPausedUntil ?? null, null);

      await echo(h, phoneNumberId(), contact);
      await sleep(300);
      assert.match(
        await h.metrics.render(),
        /channel_echo_events_total{result="unknown_number"} 1/,
      );
      const raw = h.logs.raw();
      for (const secret of [SECRET_TEAM, SECRET_TEXT, contact]) {
        assert.equal(logContains(raw, secret), false, secret);
      }
    });
  });
});
