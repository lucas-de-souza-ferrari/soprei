import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { AttendanceService } from '../../application/attendance/attendance.service.js';
import { ClientService } from '../../application/clients/client.service.js';
import type { LlmGenerateInput, LlmProvider } from '../../application/ports/llm-provider.js';
import { Result } from '../../shared/types/index.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import {
  createDatabase,
  PrismaAttendanceUnitOfWork,
  PrismaClientRepository,
  PrismaConversationRepository,
  PrismaMessageRepository,
  type Database,
} from '../database/index.js';
import {
  MOCK_FAIL_MARKER,
  MOCK_HANG_MARKER,
  MockLlmProvider,
} from '../external-apis/llm/mock-llm.provider.js';
import { createMetrics } from '../metrics/index.js';
import { buildServer } from './server.js';

const config = loadIntegrationConfig();
const logs = captureLogs();
// Chaves descartáveis, só deste arquivo (e só na memória do processo de teste).
const KEY = `it-${randomUUID()}-${randomUUID()}`;
const METRICS_TOKEN = `it-${randomUUID()}-${randomUUID()}`;
const auth = { authorization: `Bearer ${KEY}` };

interface ClientBody {
  id: string;
}
interface ReplyBody {
  conversationId: string;
  messageId: string;
  reply: { id: string; text: string; isFallback: boolean };
  duplicate: boolean;
}
interface PageBody<T> {
  items: T[];
  nextCursor: string | null;
}
interface MessageBody {
  id: string;
  role: string;
  content: string;
  isFallback: boolean;
}

let database: Database;
let tenants: TestTenants;
let app: FastifyInstance;
let mock: MockLlmProvider;

/** Provider com latência aleatória, para que pedidos simultâneos se intercalem de verdade. */
class SlowProvider implements LlmProvider {
  readonly name = 'mock';
  constructor(private readonly inner: MockLlmProvider) {}
  async generate(input: LlmGenerateInput) {
    await sleep(5 + Math.floor(Math.random() * 25));
    return this.inner.generate(input);
  }
}

const slug = (label: string): string => `${label}-${randomBytes(6).toString('hex')}`;

before(async () => {
  database = createDatabase(config, logs.logger);
  tenants = new TestTenants(database.prisma);
  mock = new MockLlmProvider({ recordCalls: true });
  const clientRepository = new PrismaClientRepository(database.prisma);
  const metrics = createMetrics();
  app = buildServer({
    logger: logs.logger,
    metrics,
    metricsToken: METRICS_TOKEN,
    readiness: {
      database: () => database.check(),
      redis: () => Promise.resolve(Result.ok(undefined)),
    },
    admin: {
      apiKey: KEY,
      clients: new ClientService(clientRepository),
      attendance: new AttendanceService({
        clients: clientRepository,
        conversations: new PrismaConversationRepository(database.prisma),
        messages: new PrismaMessageRepository(database.prisma),
        unitOfWork: new PrismaAttendanceUnitOfWork(database.prisma),
        llm: new SlowProvider(mock),
        logger: logs.logger,
        metrics,
        options: { llmTimeoutMs: 400, inFlightTimeoutMs: 60_000 },
      }),
    },
  });
  await app.ready();
});

after(async () => {
  try {
    await app.close();
    await tenants.cleanup();
  } finally {
    await database.close();
  }
});

async function createClient(label: string, persona?: string): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/admin/clients',
    headers: auth,
    payload: { name: `Empresa ${label}`, slug: slug(label) },
  });
  assert.equal(created.statusCode, 201);
  const { id } = created.json<ClientBody>();
  tenants.track(id);
  if (persona !== undefined) {
    const patched = await app.inject({
      method: 'PATCH',
      url: `/admin/clients/${id}`,
      headers: auth,
      payload: { persona },
    });
    assert.equal(patched.statusCode, 200);
  }
  return id;
}

function send(
  clientId: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `/admin/clients/${clientId}/messages`,
    headers: { ...auth, ...headers },
    payload: payload as object,
  });
}

const metricsBody = async (): Promise<string> =>
  (
    await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    })
  ).body;

describe('POST /admin/clients/:clientId/messages contra o PostgreSQL de testes', () => {
  it('fluxo completo: persona definida por PATCH, duas mensagens, duplicata, histórico e listagens', async () => {
    const clientId = await createClient('fluxo', 'Persona-Fluxo-HTTP');
    const first = await send(clientId, {
      contactRef: 'tel-1',
      text: 'fluxo-um',
      externalId: 'e-1',
    });
    assert.equal(first.statusCode, 201);
    const firstBody = first.json<ReplyBody>();
    assert.match(firstBody.reply.text, /Persona-Fluxo-HTTP/);

    // A ordem do histórico é por `createdAt` (ms): sem folga, a pergunta seguinte pode cair no
    // mesmo milissegundo da resposta anterior e inverter a ordem conferida mais abaixo.
    await sleep(5);
    const second = await send(clientId, { contactRef: 'tel-1', text: 'fluxo-dois' });
    assert.equal(second.statusCode, 201);
    assert.equal(second.json<ReplyBody>().conversationId, firstBody.conversationId);

    const duplicate = await send(clientId, {
      contactRef: 'tel-1',
      text: 'fluxo-um',
      externalId: 'e-1',
    });
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.json<ReplyBody>().duplicate, true);
    assert.deepEqual(duplicate.json<ReplyBody>().reply, firstBody.reply);
    assert.equal(mock.calls.filter((call) => call.userMessage === 'fluxo-um').length, 1);

    const history = await app.inject({
      method: 'GET',
      url: `/admin/clients/${clientId}/conversations/${firstBody.conversationId}/messages`,
      headers: auth,
    });
    assert.equal(history.statusCode, 200);
    assert.deepEqual(
      history.json<PageBody<MessageBody>>().items.map((m) => [m.role, m.isFallback]),
      [
        ['USER', false],
        ['ASSISTANT', false],
        ['USER', false],
        ['ASSISTANT', false],
      ],
    );
    const conversations = await app.inject({
      method: 'GET',
      url: `/admin/clients/${clientId}/conversations`,
      headers: auth,
    });
    assert.equal(conversations.json<PageBody<unknown>>().items.length, 1);
  });

  it('falha forçada do mock: 201 com o fallback e métricas de LLM e de fallback em /metrics', async () => {
    const clientId = await createClient('falha');
    const response = await send(clientId, {
      contactRef: 'tel-1',
      text: `falha ${MOCK_FAIL_MARKER}`,
    });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json<ReplyBody>().reply.isFallback, true);

    const body = await metricsBody();
    assert.match(body, /llm_requests_total\{provider="mock",result="error"\} [1-9]/);
    assert.match(body, /llm_request_duration_seconds_count\{provider="mock"\} [1-9]/);
    assert.match(body, /attendance_fallbacks_total [1-9]/);
    // Nenhum label com clientId/userId (o padrão da rota `:clientId` aparece só no label `route`).
    assert.doesNotMatch(body, /[{,]s*(client_?id|user_?id)s*=/i);
    assert.ok(!body.includes(clientId));
  });

  it('provider que não responde: timeout vira fallback e a métrica registra "timeout"', async () => {
    const clientId = await createClient('timeout');
    const response = await send(clientId, {
      contactRef: 'tel-1',
      text: `espera ${MOCK_HANG_MARKER}`,
    });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json<ReplyBody>().reply.isFallback, true);
    assert.match(
      await metricsBody(),
      /llm_requests_total\{provider="mock",result="timeout"\} [1-9]/,
    );
    const warn = logs
      .lines()
      .find((line) => line.reason === 'timeout' && line.clientId === clientId);
    assert.ok(warn, 'o timeout foi logado com o clientId');
    assert.equal(typeof warn.requestId, 'string');
  });

  it('cliente inexistente: 404; suspenso: 403; nada é gravado', async () => {
    const ghost = await send(randomUUID(), { contactRef: 'c', text: 'oi-fantasma' });
    assert.equal(ghost.statusCode, 404);

    const removed = await createClient('removido');
    await app.inject({ method: 'DELETE', url: `/admin/clients/${removed}`, headers: auth });
    assert.equal((await send(removed, { contactRef: 'c', text: 'oi-removido' })).statusCode, 404);

    const suspended = await createClient('suspenso');
    await app.inject({
      method: 'PATCH',
      url: `/admin/clients/${suspended}`,
      headers: auth,
      payload: { status: 'SUSPENDED' },
    });
    const blocked = await send(suspended, { contactRef: 'c', text: 'oi-suspenso' });
    assert.equal(blocked.statusCode, 403);

    for (const id of [removed, suspended]) {
      const list = await app.inject({
        method: 'GET',
        url: `/admin/clients/${id}/conversations`,
        headers: auth,
      });
      if (id === suspended) assert.deepEqual(list.json<PageBody<unknown>>().items, []);
      else assert.equal(list.statusCode, 404);
    }
    assert.ok(!mock.calls.some((call) => call.userMessage.startsWith('oi-')));
  });

  it('entrada inválida: 400', async () => {
    const clientId = await createClient('invalido');
    for (const payload of [
      { contactRef: 'c', text: '' },
      { contactRef: 'c', text: '   ' },
      { contactRef: 'c', text: 'a'.repeat(4001) },
      { contactRef: '', text: 'oi' },
      { contactRef: 'a\u0000b', text: 'oi' },
      { contactRef: 'c', text: 'oi\u0000' },
    ]) {
      assert.equal((await send(clientId, payload)).statusCode, 400);
    }
    // Nada foi gravado (nem conversa): o NUL não chegou ao banco.
    const none = await app.inject({
      method: 'GET',
      url: `/admin/clients/${clientId}/conversations`,
      headers: auth,
    });
    assert.deepEqual(none.json<PageBody<unknown>>().items, []);
    // Persona com NUL: 400, não 500.
    const patched = await app.inject({
      method: 'PATCH',
      url: `/admin/clients/${clientId}`,
      headers: auth,
      payload: { persona: 'com\u0000nul' },
    });
    assert.equal(patched.statusCode, 400);
    assert.equal((await send('nao-uuid', { contactRef: 'c', text: 'oi' })).statusCode, 400);
  });

  it('dois pedidos simultâneos do mesmo externalId: um 201 e o outro 200 (mesma resposta) ou 409', async () => {
    const clientId = await createClient('simultaneo');
    const payload = { contactRef: 'tel-1', text: 'simultaneo-unico', externalId: 'e-sim' };
    const [one, two] = await Promise.all([send(clientId, payload), send(clientId, payload)]);
    const statuses = [one.statusCode, two.statusCode].sort((x, y) => x - y);
    assert.ok(
      statuses[0] === 200 || statuses[0] === 201 || statuses[0] === 409,
      `statuses ${statuses.join(',')}`,
    );
    assert.equal(
      statuses.filter((status) => status === 201).length,
      1,
      `statuses ${statuses.join(',')}`,
    );
    assert.ok(statuses.every((status) => [200, 201, 409].includes(status)));
    assert.equal(mock.calls.filter((call) => call.userMessage === 'simultaneo-unico').length, 1);
    if (statuses.includes(200)) {
      assert.deepEqual(one.json<ReplyBody>().reply, two.json<ReplyBody>().reply);
    }
  });
});

describe('isolamento via HTTP (clientes A e B)', () => {
  it('mesmo contactRef e mesmo externalId: conversas, respostas e persona independentes', async () => {
    const a = await createClient('iso-a', 'Persona-A-HTTP');
    const b = await createClient('iso-b', 'Persona-B-HTTP');
    const sentA = await send(a, { contactRef: 'mesmo', text: 'httpA-1', externalId: 'ext' });
    const sentB = await send(b, { contactRef: 'mesmo', text: 'httpB-1', externalId: 'ext' });
    assert.equal(sentA.statusCode, 201);
    assert.equal(sentB.statusCode, 201);
    const replyA = sentA.json<ReplyBody>();
    const replyB = sentB.json<ReplyBody>();
    assert.notEqual(replyA.conversationId, replyB.conversationId);
    assert.match(replyA.reply.text, /Persona-A-HTTP/);
    assert.match(replyB.reply.text, /Persona-B-HTTP/);

    // Intercala mais mensagens e confere o que o LLM recebeu.
    await send(a, { contactRef: 'mesmo', text: 'httpA-2' });
    await send(b, { contactRef: 'mesmo', text: 'httpB-2' });
    const callsA = mock.calls.filter((candidate) => candidate.userMessage.startsWith('httpA-'));
    const callsB = mock.calls.filter((candidate) => candidate.userMessage.startsWith('httpB-'));
    assert.equal(callsA.length, 2);
    assert.equal(callsB.length, 2);
    assert.equal(callsA[1]?.history.length, 2, 'a 2ª mensagem de A tem histórico (não é vácuo)');
    assert.equal(callsB[1]?.history.length, 2, 'a 2ª mensagem de B tem histórico (não é vácuo)');
    for (const call of callsA) {
      assert.equal(call.systemPrompt, 'Persona-A-HTTP');
      assert.ok(call.history.every((turn) => !turn.content.includes('httpB-')));
    }
    for (const call of callsB) {
      assert.equal(call.systemPrompt, 'Persona-B-HTTP');
      assert.ok(call.history.every((turn) => !turn.content.includes('httpA-')));
    }

    // O conversationId de B com o clientId de A: 404 e nada de B na resposta.
    const cross = await app.inject({
      method: 'GET',
      url: `/admin/clients/${a}/conversations/${replyB.conversationId}/messages`,
      headers: auth,
    });
    assert.equal(cross.statusCode, 404);
    assert.ok(!cross.body.includes('httpB-'));
    const listA = await app.inject({
      method: 'GET',
      url: `/admin/clients/${a}/conversations`,
      headers: auth,
    });
    assert.ok(!listA.body.includes(replyB.conversationId));
    const historyA = await app.inject({
      method: 'GET',
      url: `/admin/clients/${a}/conversations/${replyA.conversationId}/messages`,
      headers: auth,
    });
    assert.ok(!historyA.body.includes('httpB-'));
  });
});

describe('contexto de log e privacidade', () => {
  it('requisições simultâneas de clientes diferentes mantêm cada uma o seu clientId nos logs', async () => {
    const clientIds = await Promise.all(
      Array.from({ length: 4 }, (_, i) => createClient(`ctx-${String(i)}`)),
    );
    const requestIds = clientIds.map(
      (_, i) => `req-ctx-${randomBytes(6).toString('hex')}-${String(i)}`,
    );
    await Promise.all(
      clientIds.map((clientId, i) =>
        Promise.all([
          send(
            clientId,
            { contactRef: 'tel-1', text: `ctx-${String(i)}-a` },
            { 'x-request-id': requestIds[i] ?? '' },
          ),
        ]),
      ),
    );

    for (const [i, clientId] of clientIds.entries()) {
      const lines = logs.lines().filter((line) => line.requestId === requestIds[i]);
      assert.ok(lines.length >= 2, 'log do atendimento e da requisição');
      for (const line of lines) {
        assert.equal(line.clientId, clientId, `linha "${String(line.msg)}" com o clientId errado`);
      }
      assert.ok(lines.some((line) => line.msg === 'mensagem atendida'));
      assert.ok(lines.some((line) => line.msg === 'requisição concluída'));
    }
  });

  it('o conteúdo das mensagens, a persona e o contactRef não aparecem em nenhuma linha de log', async () => {
    const persona = 'PERSONA-SECRETA-PRIV-77';
    const clientId = await createClient('privacidade', persona);
    const secrets = ['TEXTO-SECRETO-PRIV-1', 'TEXTO-SECRETO-PRIV-2', 'TEXTO-SECRETO-PRIV-3'];
    const contact = 'TEL-5511988887777';

    await send(clientId, { contactRef: contact, text: secrets[0] ?? '', externalId: 'p-1' });
    await send(clientId, { contactRef: contact, text: secrets[0] ?? '', externalId: 'p-1' });
    await send(clientId, { contactRef: contact, text: `${secrets[1] ?? ''} ${MOCK_FAIL_MARKER}` });
    await send(clientId, { contactRef: contact, text: `${secrets[2] ?? ''} ${MOCK_HANG_MARKER}` });
    // Entradas inválidas e corpo malformado também não podem ecoar o conteúdo.
    await send(clientId, { contactRef: `${contact}\u0000`, text: secrets[0] ?? '' });
    // Texto com NUL (400): o conteúdo também não pode ser ecoado no log.
    await send(clientId, { contactRef: contact, text: `${secrets[2] ?? ''}\u0000` });
    await app.inject({
      method: 'POST',
      url: `/admin/clients/${clientId}/messages`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: `{"contactRef":"${contact}","text":"${secrets[1] ?? ''}`,
    });
    await app.inject({
      method: 'GET',
      url: `/admin/clients/${clientId}/conversations`,
      headers: auth,
    });

    const raw = logs.raw();
    for (const secret of [...secrets, persona, contact, '5511988887777']) {
      assert.ok(!raw.includes(secret), `o log vazou ${secret}`);
    }
    assert.ok(!raw.includes('[mock] Recebi'), 'nem a resposta (que ecoa o texto)');
    // Nem nos labels das métricas.
    const body = await metricsBody();
    for (const secret of [...secrets, persona, contact]) assert.ok(!body.includes(secret));
  });
});
