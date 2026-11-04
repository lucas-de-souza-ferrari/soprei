import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { AttendanceService } from '../../application/attendance/attendance.service.js';
import { ChannelInboundProcessor } from '../../application/channel/channel-inbound.processor.js';
import type {
  FlushJob,
  InboundJob,
  InboundJobQueue,
} from '../../application/ports/inbound-job-queue.js';
import { NonRetryableJobError } from '../../application/ports/inbound-job-queue.js';
import type { Company } from '../../domain/index.js';
import { Result, SecretString } from '../../shared/types/index.js';
import { buildChannelCredentials } from '../../test-support/channel-credentials.js';
import { FakeGraphApi, graphError } from '../../test-support/fake-graph-api.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { captureLogs, type LogCapture } from '../../test-support/log-capture.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
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
import { createMetrics, type Metrics } from '../metrics/index.js';

const config = loadIntegrationConfig();
const LEGACY_TOKEN = `EAAG-legado-${randomUUID()}`;
const SECRET_TEXT = 'texto-secreto-do-contato-015';

const graph = new FakeGraphApi();
let database: Database;
let tenants: TestTenants;

before(async () => {
  await graph.start();
  database = createDatabase(config, captureLogs().logger);
  tenants = new TestTenants(database.prisma);
});

after(async () => {
  try {
    await tenants.cleanup();
  } finally {
    await database.close();
    await graph.stop();
  }
});

const digits = (): string => `7${randomBytes(6).readUIntBE(0, 6).toString().padStart(15, '0')}`;

interface Harness {
  readonly processor: ChannelInboundProcessor;
  readonly stack: ReturnType<typeof buildChannelCredentials>;
  readonly llm: MockLlmProvider;
  readonly logs: LogCapture;
  readonly metrics: Metrics;
}

function setup(options: { legacyToken?: string } = {}): Harness {
  graph.reset();
  const logs = captureLogs();
  const metrics = createMetrics();
  const { prisma } = database;
  const companies = new PrismaCompanyRepository(prisma);
  const messages = new PrismaMessageRepository(prisma);
  const llm = new MockLlmProvider({ recordCalls: true });
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
  const stack = buildChannelCredentials(prisma, {
    ...(options.legacyToken === undefined ? {} : { legacyToken: options.legacyToken }),
    metrics,
  });
  const queue: Pick<InboundJobQueue, 'scheduleFlush'> = {
    scheduleFlush: () => Promise.resolve(Result.ok(undefined)),
  };
  const processor = new ChannelInboundProcessor({
    attendance,
    companies,
    messages,
    credentials: stack.credentials,
    connections: stack.connections,
    metrics,
    sender: new WhatsappCloudApiClient({
      baseUrl: graph.baseUrl,
      graphApiVersion: 'v26.0',
      timeoutMs: 1_000,
      metrics,
    }),
    queue,
    batch: { windowMs: 0, maxWaitMs: 0, maxMessages: 10, maxChars: 8_000 },
    logger: logs.logger,
  });
  return { processor, stack, llm, logs, metrics };
}

/** Empresa com número e, se `token` for dado, conexão própria (token cifrado pela empresa dona). */
async function connectedCompany(
  h: Harness,
  label: string,
  token: string | null,
): Promise<{ company: Company; phoneNumberId: string }> {
  const phoneNumberId = digits();
  const company = await tenants.createCompany(label, phoneNumberId);
  if (token !== null) {
    await h.stack.connections.save(company.id, {
      wabaId: digits(),
      tokenCiphertext: h.stack.cipher.encrypt(company.id, new SecretString(token)),
      tokenExpiresAt: null,
    });
  }
  return { company, phoneNumberId };
}

const contact = (): string => `5511${randomBytes(4).readUInt32BE(0).toString().padStart(10, '0')}`;

function textJob(
  companyId: string,
  phoneNumberId: string,
  contactRef: string,
  text = SECRET_TEXT,
): Extract<InboundJob, { kind: 'text' }> {
  return {
    kind: 'text',
    companyId,
    phoneNumberId,
    contactRef,
    text,
    externalId: `wamid.${randomUUID()}`,
    requestId: 'req-12345678',
  };
}

const flushOf = (job: Extract<InboundJob, { kind: 'text' }>): FlushJob => ({
  kind: 'flush',
  companyId: job.companyId,
  phoneNumberId: job.phoneNumberId,
  contactRef: job.contactRef,
  requestId: job.requestId,
});

const MORE = { finalAttempt: false };

async function converse(h: Harness, job: Extract<InboundJob, { kind: 'text' }>) {
  await h.processor.process(job, MORE);
  return h.processor.process(flushOf(job), MORE);
}

describe('envio com o token da empresa do job (spec 015, Postgres real, Graph falso)', () => {
  it('A e B com tokens e números diferentes: o par (token, número) nunca se cruza', async () => {
    const h = setup();
    const tokenA = `EAAG-A-${randomUUID()}`;
    const tokenB = `EAAG-B-${randomUUID()}`;
    const a = await connectedCompany(h, 'send-a', tokenA);
    const b = await connectedCompany(h, 'send-b', tokenB);
    const [contactA, contactB] = [contact(), contact()];

    await h.processor.process(textJob(a.company.id, a.phoneNumberId, contactA), MORE);
    await h.processor.process(textJob(b.company.id, b.phoneNumberId, contactB), MORE);
    await h.processor.process(flushOf(textJob(a.company.id, a.phoneNumberId, contactA)), MORE);
    await h.processor.process(flushOf(textJob(b.company.id, b.phoneNumberId, contactB)), MORE);

    assert.deepEqual(
      graph
        .sendPairs()
        .map((pair) => `${pair.authorization ?? ''}@${pair.phoneNumberId ?? ''}`)
        .sort(),
      [`Bearer ${tokenA}@${a.phoneNumberId}`, `Bearer ${tokenB}@${b.phoneNumberId}`].sort(),
    );
    for (const pair of graph.sendPairs()) {
      const forA = pair.phoneNumberId === a.phoneNumberId;
      assert.equal(pair.authorization, forA ? `Bearer ${tokenA}` : `Bearer ${tokenB}`);
    }
    // Nada vaza.
    for (const secret of [tokenA, tokenB, SECRET_TEXT]) {
      assert.ok(!h.logs.raw().includes(secret));
    }
  });

  it('job adulterado (número de B com a empresa A) é descartado sem enviar', async () => {
    const h = setup();
    const a = await connectedCompany(h, 'forge-a', `EAAG-A-${randomUUID()}`);
    const b = await connectedCompany(h, 'forge-b', `EAAG-B-${randomUUID()}`);
    const forged = textJob(a.company.id, b.phoneNumberId, contact());
    await h.processor.process(forged, MORE);
    await assert.rejects(
      h.processor.process(flushOf(forged), MORE),
      (error: unknown) => error instanceof NonRetryableJobError,
    );
    assert.equal(graph.sendPairs().length, 0);
  });

  it('texto cifrado copiado de A para B: o envio de B falha (tampered), sem enviar e sem marcar TOKEN_INVALID', async () => {
    const h = setup();
    const tokenA = `EAAG-A-${randomUUID()}`;
    const a = await connectedCompany(h, 'swap-a', tokenA);
    const b = await connectedCompany(h, 'swap-b', `EAAG-B-${randomUUID()}`);
    const rowA = await database.prisma.channelConnection.findFirst({
      where: { companyId: a.company.id },
    });
    assert.ok(rowA !== null);
    await database.prisma.channelConnection.updateMany({
      where: { companyId: b.company.id },
      data: { tokenCiphertext: rowA.tokenCiphertext },
    });
    const job = textJob(b.company.id, b.phoneNumberId, contact());
    await h.processor.process(job, MORE);

    await assert.rejects(
      h.processor.process(flushOf(job), MORE),
      (error: unknown) => error instanceof NonRetryableJobError,
    );

    assert.equal(graph.sendPairs().length, 0);
    const rowB = await database.prisma.channelConnection.findFirst({
      where: { companyId: b.company.id },
    });
    assert.equal(rowB?.status, 'CONNECTED');
    assert.match(
      await h.metrics.render(),
      /channel_credential_errors_total{reason="tampered"} [12]/,
    );
    assert.ok(!h.logs.raw().includes(tokenA));
    assert.ok(!h.logs.raw().includes(rowA.tokenCiphertext));
  });

  it('190: marca TOKEN_INVALID, sem texto padrão; o próximo flush é descartado sem LLM; o PUT novo reabre e responde o lote', async () => {
    const h = setup();
    const token = `EAAG-A-${randomUUID()}`;
    const a = await connectedCompany(h, 'inval-a', token);
    const b = await connectedCompany(h, 'inval-b', `EAAG-B-${randomUUID()}`);
    const contactRef = contact();
    graph.failOperation('messages', graphError(401, 190));
    const first = textJob(a.company.id, a.phoneNumberId, contactRef, 'primeira');
    await h.processor.process(first, MORE);

    await assert.rejects(
      h.processor.process(flushOf(first), MORE),
      (error: unknown) => error instanceof NonRetryableJobError,
    );

    const marked = await database.prisma.channelConnection.findFirst({
      where: { companyId: a.company.id },
    });
    assert.equal(marked?.status, 'TOKEN_INVALID');
    assert.notEqual(marked.tokenInvalidAt, null);
    assert.equal(graph.sendPairs().length, 1, 'sem texto padrão');
    assert.match(await h.metrics.render(), /channel_state_transitions_total{to="token_invalid"} 1/);
    assert.ok(!h.logs.raw().includes(token));
    assert.ok(!h.logs.raw().includes('eco:'));

    // Próxima mensagem: descartada sem chamar o LLM.
    const llmBefore = h.llm.calls.length;
    const second = textJob(a.company.id, a.phoneNumberId, contactRef, 'segunda');
    await h.processor.process(second, MORE);
    assert.equal(await h.processor.process(flushOf(second), MORE), 'discarded');
    assert.equal(h.llm.calls.length, llmBefore);
    assert.equal(graph.sendPairs().length, 1);

    // O estado de A não afeta B.
    assert.equal(await converse(h, textJob(b.company.id, b.phoneNumberId, contact())), 'done');

    // Um 190 de versão antiga não invalida o token novo.
    const oldVersion = marked.tokenVersion;
    await h.stack.connections.save(a.company.id, {
      wabaId: marked.wabaId,
      tokenCiphertext: h.stack.cipher.encrypt(
        a.company.id,
        new SecretString(`EAAG-novo-${randomUUID()}`),
      ),
      tokenExpiresAt: null,
    });
    assert.equal(
      await h.stack.connections.markTokenInvalid(a.company.id, oldVersion, new Date()),
      false,
    );

    // Token novo: o próximo flush responde as duas mensagens pendentes de uma vez.
    const third = textJob(a.company.id, a.phoneNumberId, contactRef, 'terceira');
    await h.processor.process(third, MORE);
    assert.equal(await h.processor.process(flushOf(third), MORE), 'done');
    const last = h.llm.calls[h.llm.calls.length - 1];
    assert.ok(last !== undefined);
    // A primeira já tinha resposta gravada (o que falhou foi o envio); as duas seguintes estavam pendentes.
    assert.ok(!last.userMessage.includes('primeira'));
    assert.ok(last.userMessage.includes('segunda'));
    assert.ok(last.userMessage.includes('terceira'));
  });

  it('outro código permanente (131047) não muda o estado', async () => {
    const h = setup();
    const a = await connectedCompany(h, 'perm-a', `EAAG-A-${randomUUID()}`);
    graph.failOperation('messages', graphError(400, 131047));
    const job = textJob(a.company.id, a.phoneNumberId, contact());
    await h.processor.process(job, MORE);
    await assert.rejects(h.processor.process(flushOf(job), MORE), NonRetryableJobError);
    const row = await database.prisma.channelConnection.findFirst({
      where: { companyId: a.company.id },
    });
    assert.equal(row?.status, 'CONNECTED');
  });

  it('LEGACY: usa o token global se existe; sem ele não envia e loga erro; com conexão nunca usa o global', async () => {
    const withLegacy = setup({ legacyToken: LEGACY_TOKEN });
    const legacy = await connectedCompany(withLegacy, 'legacy', null);
    const own = await connectedCompany(withLegacy, 'own', `EAAG-proprio-${randomUUID()}`);
    await converse(withLegacy, textJob(legacy.company.id, legacy.phoneNumberId, contact()));
    await converse(withLegacy, textJob(own.company.id, own.phoneNumberId, contact()));
    const pairs = graph.sendPairs();
    assert.equal(pairs.length, 2);
    assert.equal(
      pairs.find((pair) => pair.phoneNumberId === legacy.phoneNumberId)?.authorization,
      `Bearer ${LEGACY_TOKEN}`,
    );
    assert.notEqual(
      pairs.find((pair) => pair.phoneNumberId === own.phoneNumberId)?.authorization,
      `Bearer ${LEGACY_TOKEN}`,
    );
    assert.ok(!withLegacy.logs.raw().includes(LEGACY_TOKEN));

    const noLegacy = setup();
    const orphan = await connectedCompany(noLegacy, 'orphan', null);
    await converse(noLegacy, textJob(orphan.company.id, orphan.phoneNumberId, contact()));
    assert.equal(graph.sendPairs().length, 0);
    assert.ok(noLegacy.logs.lines().some((line) => line.level === 50));
  });
});
