import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { AttendanceService } from '../../application/attendance/attendance.service.js';
import { ClientId } from '../../domain/index.js';
import { ClientService } from '../../application/clients/client.service.js';
import { MockLlmProvider } from '../../infrastructure/external-apis/llm/mock-llm.provider.js';
import { buildServer } from '../../infrastructure/http/server.js';
import { steppingClock } from '../../test-support/clock.js';
import { InMemoryAttendanceStore } from '../../test-support/in-memory-attendance.js';
import { InMemoryClientRepository } from '../../test-support/in-memory-client.repository.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { Result } from '../../shared/types/index.js';

// Chave descartável, só deste arquivo.
const KEY = `test-${randomUUID()}-${randomUUID()}`;
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
  externalId: string | null;
  replyToId: string | null;
  sentAt: string | null;
}
interface ErrorBody {
  error: { code: string; message: string };
}

describe('rotas de atendimento (/admin/clients/:clientId/...)', () => {
  let app: FastifyInstance;
  let store: InMemoryAttendanceStore;
  const logs = captureLogs();
  const llm = new MockLlmProvider({ recordCalls: true });

  before(async () => {
    const clients = new InMemoryClientRepository();
    // Relógio determinístico: com o real, dois pedidos no mesmo milissegundo invertem a ordem
    // da resposta e da pergunta seguinte (falhou no CI, ora no Node 22, ora na LTS).
    const clock = steppingClock();
    store = new InMemoryAttendanceStore(clock);
    app = buildServer({
      logger: logs.logger,
      readiness: {
        database: () => Promise.resolve(Result.ok(undefined)),
        redis: () => Promise.resolve(Result.ok(undefined)),
      },
      admin: {
        apiKey: KEY,
        clients: new ClientService(clients),
        attendance: new AttendanceService({
          clients,
          conversations: store.conversations,
          messages: store.messages,
          unitOfWork: store,
          llm,
          logger: logs.logger,
          options: { llmTimeoutMs: 1_000, inFlightTimeoutMs: 60_000, now: clock },
        }),
      },
    });
    await app.ready();
  });
  after(async () => {
    await app.close();
  });

  async function createClient(slug: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/clients',
      headers: auth,
      payload: { name: `Cliente ${slug}`, slug },
    });
    assert.equal(response.statusCode, 201);
    return response.json<ClientBody>().id;
  }

  const send = (clientId: string, payload: unknown, headers: Record<string, string> = auth) =>
    app.inject({
      method: 'POST',
      url: `/admin/clients/${clientId}/messages`,
      headers,
      payload: payload as object,
    });

  describe('POST /admin/clients/:clientId/messages', () => {
    it('201 com a resposta; a segunda mensagem reaproveita a conversa', async () => {
      const clientId = await createClient('post-ok');
      const first = await send(clientId, { contactRef: 'c1', text: 'Olá' });
      assert.equal(first.statusCode, 201);
      const body = first.json<ReplyBody>();
      assert.equal(body.duplicate, false);
      assert.equal(body.reply.isFallback, false);
      assert.match(body.reply.text, /^\[mock\] Recebi: Olá/);
      assert.deepEqual(Object.keys(body).sort(), [
        'conversationId',
        'duplicate',
        'messageId',
        'reply',
      ]);

      const second = await send(clientId, { contactRef: 'c1', text: 'De novo' });
      assert.equal(second.statusCode, 201);
      assert.equal(second.json<ReplyBody>().conversationId, body.conversationId);
    });

    it('persona do cliente chega ao provider (PATCH /admin/clients/:id)', async () => {
      const clientId = await createClient('post-persona');
      const patched = await app.inject({
        method: 'PATCH',
        url: `/admin/clients/${clientId}`,
        headers: auth,
        payload: { persona: 'Persona-Rota-123' },
      });
      assert.equal(patched.statusCode, 200);
      const before = llm.calls.length;
      await send(clientId, { contactRef: 'c1', text: 'oi' });
      assert.ok(llm.calls[before]?.systemPrompt.startsWith('Persona-Rota-123\n\n'));
    });

    it('externalId repetido: 200 com a mesma resposta e duplicate=true', async () => {
      const clientId = await createClient('post-dup');
      const payload = { contactRef: 'c1', text: 'oi', externalId: 'ext-1' };
      const first = await send(clientId, payload);
      const again = await send(clientId, payload);
      assert.equal(first.statusCode, 201);
      assert.equal(again.statusCode, 200);
      assert.equal(again.json<ReplyBody>().duplicate, true);
      assert.deepEqual(again.json<ReplyBody>().reply, first.json<ReplyBody>().reply);
    });

    it('falha do provider: 201 com o fallback educado', async () => {
      const clientId = await createClient('post-fallback');
      const response = await send(clientId, { contactRef: 'c1', text: 'oi [[mock:fail]]' });
      assert.equal(response.statusCode, 201);
      const body = response.json<ReplyBody>();
      assert.equal(body.reply.isFallback, true);
      assert.match(body.reply.text, /^Desculpe/);
    });

    it('cliente inexistente: 404; removido: 404; suspenso: 403 (nada é gravado)', async () => {
      const ghost = await send(randomUUID(), { contactRef: 'c1', text: 'oi' });
      assert.equal(ghost.statusCode, 404);
      assert.equal(ghost.json<ErrorBody>().error.code, 'NOT_FOUND');

      const removed = await createClient('post-removed');
      await app.inject({ method: 'DELETE', url: `/admin/clients/${removed}`, headers: auth });
      assert.equal((await send(removed, { contactRef: 'c1', text: 'oi' })).statusCode, 404);

      const suspended = await createClient('post-suspended');
      await app.inject({
        method: 'PATCH',
        url: `/admin/clients/${suspended}`,
        headers: auth,
        payload: { status: 'SUSPENDED' },
      });
      const blocked = await send(suspended, { contactRef: 'c1', text: 'oi' });
      assert.equal(blocked.statusCode, 403);
      assert.equal(blocked.json<ErrorBody>().error.code, 'FORBIDDEN');
      const conversations = await app.inject({
        method: 'GET',
        url: `/admin/clients/${suspended}/conversations`,
        headers: auth,
      });
      assert.equal(conversations.statusCode, 200);
      assert.deepEqual(conversations.json<PageBody<unknown>>().items, []);
    });

    it('entrada inválida: 400 (texto vazio ou só espaços, > 4000, contactRef ruim, clientId malformado)', async () => {
      const clientId = await createClient('post-400');
      for (const payload of [
        { contactRef: 'c', text: '' },
        { contactRef: 'c', text: '   ' },
        { contactRef: 'c', text: 'a'.repeat(4001) },
        { contactRef: '', text: 'oi' },
        { contactRef: 'a\u0007b', text: 'oi' },
        { contactRef: 'c', text: 'oi\u0000' },
        { contactRef: 'c'.repeat(129), text: 'oi' },
        { contactRef: 'c', text: 'oi', externalId: 'e'.repeat(129) },
        { contactRef: 'c', text: 'oi', clientId: randomUUID() },
        { text: 'oi' },
        {},
      ]) {
        const response = await send(clientId, payload);
        assert.equal(response.statusCode, 400, JSON.stringify(payload).slice(0, 80));
        assert.equal(response.json<ErrorBody>().error.code, 'VALIDATION_ERROR');
      }
      assert.equal((await send('nao-e-uuid', { contactRef: 'c', text: 'oi' })).statusCode, 400);
      const noBody = await app.inject({
        method: 'POST',
        url: `/admin/clients/${clientId}/messages`,
        headers: auth,
      });
      assert.equal(noBody.statusCode, 400);
    });

    it('JSON malformado: 400 e o conteúdo enviado não vai para o log', async () => {
      const clientId = await createClient('post-badjson');
      const response = await app.inject({
        method: 'POST',
        url: `/admin/clients/${clientId}/messages`,
        headers: { ...auth, 'content-type': 'application/json' },
        payload: '{"contactRef":"c","text":"SEGREDO-JSON-QUEBRADO',
      });
      assert.equal(response.statusCode, 400);
      assert.ok(!logs.raw().includes('SEGREDO-JSON-QUEBRADO'));
    });

    it('sem chave: 401 (nenhuma rota de atendimento é pública)', async () => {
      const clientId = await createClient('post-401');
      const calls: readonly [string, string][] = [
        ['POST', `/admin/clients/${clientId}/messages`],
        ['GET', `/admin/clients/${clientId}/conversations`],
        ['GET', `/admin/clients/${clientId}/conversations/${randomUUID()}/messages`],
      ];
      for (const [method, url] of calls) {
        for (const headers of [{}, { authorization: 'Bearer errada' }]) {
          const response = await app.inject({
            method: method as 'GET' | 'POST',
            url,
            headers,
            payload: method === 'POST' ? { contactRef: 'c', text: 'oi' } : undefined,
          });
          assert.equal(response.statusCode, 401, `${method} ${url}`);
        }
      }
    });
  });

  describe('GET conversations e messages', () => {
    it('expõe sentAt: nulo na resposta não enviada (simulador) e ISO depois da marca de envio', async () => {
      const clientId = await createClient('get-sent');
      const first = await send(clientId, { contactRef: 'c1', text: 'um' });
      const { conversationId } = first.json<ReplyBody>();
      const list = async () =>
        (
          await app.inject({
            method: 'GET',
            url: `/admin/clients/${clientId}/conversations/${conversationId}/messages`,
            headers: auth,
          })
        ).json<PageBody<MessageBody>>().items;

      const before = await list();
      assert.deepEqual(
        before.map((m) => m.sentAt),
        [null, null],
      );

      const reply = before[1];
      assert.ok(reply !== undefined);
      const sentAt = new Date('2026-10-28T12:00:00.000Z');
      const marked = await store.messages.markSent(ClientId.parse(clientId), reply.id, {
        channelMessageId: 'wamid.out',
        sentAt,
      });
      assert.equal(marked, true);
      const after = await list();
      assert.equal(after[0]?.sentAt, null);
      assert.equal(after[1]?.sentAt, sentAt.toISOString());
    });

    it('lista conversas e o histórico em ordem cronológica, com paginação', async () => {
      const clientId = await createClient('get-ok');
      const first = await send(clientId, { contactRef: 'c1', text: 'um', externalId: 'e1' });
      await send(clientId, { contactRef: 'c1', text: 'dois' });
      await send(clientId, { contactRef: 'c2', text: 'tres' });
      const { conversationId } = first.json<ReplyBody>();

      const conversations = await app.inject({
        method: 'GET',
        url: `/admin/clients/${clientId}/conversations?limit=1`,
        headers: auth,
      });
      assert.equal(conversations.statusCode, 200);
      const page = conversations.json<PageBody<{ id: string; contactRef: string }>>();
      assert.equal(page.items.length, 1);
      assert.equal(page.items[0]?.id, conversationId);
      assert.equal(page.items[0].contactRef, 'c1');
      assert.notEqual(page.nextCursor, null);
      const next = await app.inject({
        method: 'GET',
        url: `/admin/clients/${clientId}/conversations?limit=1&cursor=${page.nextCursor ?? ''}`,
        headers: auth,
      });
      assert.equal(next.json<PageBody<{ contactRef: string }>>().items[0]?.contactRef, 'c2');

      const messages = await app.inject({
        method: 'GET',
        url: `/admin/clients/${clientId}/conversations/${conversationId}/messages`,
        headers: auth,
      });
      assert.equal(messages.statusCode, 200);
      const items = messages.json<PageBody<MessageBody>>().items;
      assert.deepEqual(
        items.map((m) => m.role),
        ['USER', 'ASSISTANT', 'USER', 'ASSISTANT'],
      );
      assert.equal(items[0]?.content, 'um');
      assert.equal(items[0].externalId, 'e1');
      assert.equal(items[1]?.replyToId, items[0].id);
      assert.deepEqual(Object.keys(items[0]).sort(), [
        'content',
        'createdAt',
        'externalId',
        'id',
        'isFallback',
        'replyToId',
        'role',
        'sentAt',
      ]);

      const paged = await app.inject({
        method: 'GET',
        url: `/admin/clients/${clientId}/conversations/${conversationId}/messages?limit=3`,
        headers: auth,
      });
      assert.equal(paged.json<PageBody<MessageBody>>().items.length, 3);
      assert.notEqual(paged.json<PageBody<MessageBody>>().nextCursor, null);
    });

    it('conversa de outro cliente: 404; ids malformados: 400; cliente inexistente: 404', async () => {
      const a = await createClient('get-iso-a');
      const b = await createClient('get-iso-b');
      const sentB = await send(b, { contactRef: 'mesmo', text: 'segredo-do-B' });
      await send(a, { contactRef: 'mesmo', text: 'texto-do-A' });
      const conversationB = sentB.json<ReplyBody>().conversationId;

      const cross = await app.inject({
        method: 'GET',
        url: `/admin/clients/${a}/conversations/${conversationB}/messages`,
        headers: auth,
      });
      assert.equal(cross.statusCode, 404);
      assert.ok(!cross.body.includes('segredo-do-B'));

      const listA = await app.inject({
        method: 'GET',
        url: `/admin/clients/${a}/conversations`,
        headers: auth,
      });
      assert.ok(!listA.body.includes(conversationB));

      for (const url of [
        `/admin/clients/nao-uuid/conversations`,
        `/admin/clients/${a}/conversations/nao-uuid/messages`,
        `/admin/clients/nao-uuid/conversations/${conversationB}/messages`,
        `/admin/clients/${a}/conversations?limit=0`,
        `/admin/clients/${a}/conversations?limit=201`,
        `/admin/clients/${a}/conversations?cursor=lixo`,
      ]) {
        const response = await app.inject({ method: 'GET', url, headers: auth });
        assert.equal(response.statusCode, 400, url);
      }
      const ghost = await app.inject({
        method: 'GET',
        url: `/admin/clients/${randomUUID()}/conversations`,
        headers: auth,
      });
      assert.equal(ghost.statusCode, 404);
    });
  });

  describe('contexto de log', () => {
    it('as linhas do log da requisição levam o clientId do path', async () => {
      const clientId = await createClient('log-ctx');
      const response = await send(clientId, { contactRef: 'c1', text: 'oi' });
      const requestId = response.headers['x-request-id'];
      const mine = logs.lines().filter((line) => line.requestId === requestId);
      // Se falhar (já aconteceu só no Node 22 do CI), a mensagem lista todas as linhas do pedido
      // com os campos de contexto; nunca imprime conteúdo de mensagem nem persona.
      const diagnosis = JSON.stringify(
        mine.map((line) => ({
          msg: line.msg,
          level: line.level,
          statusCode: line.statusCode,
          operation: line.operation,
          clientId: line.clientId,
          keys: Object.keys(line).sort(),
        })),
      );
      assert.ok(mine.length >= 2, `log do atendimento e log da requisição: ${diagnosis}`);
      for (const line of mine) {
        assert.equal(line.clientId, clientId, `linha sem o clientId do path: ${diagnosis}`);
      }
      assert.ok(
        mine.some((line) => line.msg === 'requisição concluída'),
        `falta o log de fim da requisição: ${diagnosis}`,
      );
    });
  });
});
