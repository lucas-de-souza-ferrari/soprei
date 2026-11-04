import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { AttendanceService } from '../../application/attendance/attendance.service.js';
import { CompanyId } from '../../domain/index.js';
import { CompanyService } from '../../application/companies/company.service.js';
import { MockLlmProvider } from '../../infrastructure/external-apis/llm/mock-llm.provider.js';
import { buildServer } from '../../infrastructure/http/server.js';
import { steppingClock } from '../../test-support/clock.js';
import { InMemoryAttendanceStore } from '../../test-support/in-memory-attendance.js';
import { InMemoryCompanyRepository } from '../../test-support/in-memory-company.repository.js';
import { bearer, buildTestAuth } from '../../test-support/in-memory-auth.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { Result } from '../../shared/types/index.js';

// `auth`: administrador da plataforma (CRUD de empresas). Cada empresa criada ganha um usuário
// próprio (`as(companyId)`), que é quem usa o simulador e lê conversas (spec 007).
let auth: { authorization: string };

interface CompanyBody {
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

describe('rotas de atendimento (/admin/companies/:companyId/...)', () => {
  let app: FastifyInstance;
  let store: InMemoryAttendanceStore;
  const logs = captureLogs();
  const membershipHeaders = new Map<string, { authorization: string }>();
  let anyMembership: { authorization: string };
  let createMembership: (companyId: string) => Promise<{ authorization: string }>;
  /** Token do usuário da empresa; empresa desconhecido usa o de outra empresa. */
  const as = (companyId: string): { authorization: string } =>
    membershipHeaders.get(companyId) ?? anyMembership;
  const llm = new MockLlmProvider({ recordCalls: true });

  before(async () => {
    const companies = new InMemoryCompanyRepository();
    const testAuth = buildTestAuth({ logger: logs.logger, companies });
    membershipHeaders.clear();
    const authTokens = testAuth;
    createMembership = async (companyId) =>
      bearer((await authTokens.membershipToken(CompanyId.parse(companyId))).accessToken);
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
      auth: testAuth.service,
      admin: {
        companies: new CompanyService(companies),
        attendance: new AttendanceService({
          companies,
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
    auth = bearer((await testAuth.platformToken()).accessToken);
    const seed = await companies.create({ name: 'Empresa base', slug: 'empresa-base' });
    anyMembership = await createMembership(seed.id);
  });
  after(async () => {
    await app.close();
  });

  async function createCompany(slug: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/companies',
      headers: auth,
      payload: { name: `Empresa ${slug}`, slug },
    });
    assert.equal(response.statusCode, 201);
    const { id } = response.json<CompanyBody>();
    membershipHeaders.set(id, await createMembership(id));
    return id;
  }

  const send = (
    companyId: string,
    payload: unknown,
    headers: Record<string, string> = as(companyId),
  ) =>
    app.inject({
      method: 'POST',
      url: `/admin/companies/${companyId}/messages`,
      headers,
      payload: payload as object,
    });

  describe('POST /admin/companies/:companyId/messages', () => {
    it('201 com a resposta; a segunda mensagem reaproveita a conversa', async () => {
      const companyId = await createCompany('post-ok');
      const first = await send(companyId, { contactRef: 'c1', text: 'Olá' });
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

      const second = await send(companyId, { contactRef: 'c1', text: 'De novo' });
      assert.equal(second.statusCode, 201);
      assert.equal(second.json<ReplyBody>().conversationId, body.conversationId);
    });

    it('persona da empresa chega ao provider (PATCH /admin/companies/:id)', async () => {
      const companyId = await createCompany('post-persona');
      const patched = await app.inject({
        method: 'PATCH',
        url: `/admin/companies/${companyId}`,
        headers: auth,
        payload: { persona: 'Persona-Rota-123' },
      });
      assert.equal(patched.statusCode, 200);
      const before = llm.calls.length;
      await send(companyId, { contactRef: 'c1', text: 'oi' });
      assert.ok(llm.calls[before]?.systemPrompt.startsWith('Persona-Rota-123\n\n'));
    });

    it('externalId repetido: 200 com a mesma resposta e duplicate=true', async () => {
      const companyId = await createCompany('post-dup');
      const payload = { contactRef: 'c1', text: 'oi', externalId: 'ext-1' };
      const first = await send(companyId, payload);
      const again = await send(companyId, payload);
      assert.equal(first.statusCode, 201);
      assert.equal(again.statusCode, 200);
      assert.equal(again.json<ReplyBody>().duplicate, true);
      assert.deepEqual(again.json<ReplyBody>().reply, first.json<ReplyBody>().reply);
    });

    it('falha do provider: 201 com o fallback educado', async () => {
      const companyId = await createCompany('post-fallback');
      const response = await send(companyId, { contactRef: 'c1', text: 'oi [[mock:fail]]' });
      assert.equal(response.statusCode, 201);
      const body = response.json<ReplyBody>();
      assert.equal(body.reply.isFallback, true);
      assert.match(body.reply.text, /^Desculpe/);
    });

    it('empresa inexistente: 404; removido: 404; suspenso: 403 (nada é gravado)', async () => {
      const ghost = await send(randomUUID(), { contactRef: 'c1', text: 'oi' });
      assert.equal(ghost.statusCode, 404);
      assert.equal(ghost.json<ErrorBody>().error.code, 'NOT_FOUND');

      const removed = await createCompany('post-removed');
      await app.inject({ method: 'DELETE', url: `/admin/companies/${removed}`, headers: auth });
      assert.equal((await send(removed, { contactRef: 'c1', text: 'oi' })).statusCode, 404);

      const suspended = await createCompany('post-suspended');
      await app.inject({
        method: 'PATCH',
        url: `/admin/companies/${suspended}`,
        headers: auth,
        payload: { status: 'SUSPENDED' },
      });
      const blocked = await send(suspended, { contactRef: 'c1', text: 'oi' });
      assert.equal(blocked.statusCode, 403);
      assert.equal(blocked.json<ErrorBody>().error.code, 'FORBIDDEN');
      const conversations = await app.inject({
        method: 'GET',
        url: `/admin/companies/${suspended}/conversations`,
        headers: as(suspended),
      });
      assert.equal(conversations.statusCode, 200);
      assert.deepEqual(conversations.json<PageBody<unknown>>().items, []);
    });

    it('entrada inválida: 400 (texto vazio ou só espaços, > 4000, contactRef ruim, companyId malformado)', async () => {
      const companyId = await createCompany('post-400');
      for (const payload of [
        { contactRef: 'c', text: '' },
        { contactRef: 'c', text: '   ' },
        { contactRef: 'c', text: 'a'.repeat(4001) },
        { contactRef: '', text: 'oi' },
        { contactRef: 'a\u0007b', text: 'oi' },
        { contactRef: 'c', text: 'oi\u0000' },
        { contactRef: 'c'.repeat(129), text: 'oi' },
        { contactRef: 'c', text: 'oi', externalId: 'e'.repeat(129) },
        { contactRef: 'c', text: 'oi', companyId: randomUUID() },
        { text: 'oi' },
        {},
      ]) {
        const response = await send(companyId, payload);
        assert.equal(response.statusCode, 400, JSON.stringify(payload).slice(0, 80));
        assert.equal(response.json<ErrorBody>().error.code, 'VALIDATION_ERROR');
      }
      // `:companyId` que não é o do token (inclusive malformado) é 404, igual a empresa inexistente.
      assert.equal((await send('nao-e-uuid', { contactRef: 'c', text: 'oi' })).statusCode, 404);
      const noBody = await app.inject({
        method: 'POST',
        url: `/admin/companies/${companyId}/messages`,
        headers: as(companyId),
      });
      assert.equal(noBody.statusCode, 400);
    });

    it('JSON malformado: 400 e o conteúdo enviado não vai para o log', async () => {
      const companyId = await createCompany('post-badjson');
      const response = await app.inject({
        method: 'POST',
        url: `/admin/companies/${companyId}/messages`,
        headers: { ...as(companyId), 'content-type': 'application/json' },
        payload: '{"contactRef":"c","text":"SEGREDO-JSON-QUEBRADO',
      });
      assert.equal(response.statusCode, 400);
      assert.ok(!logs.raw().includes('SEGREDO-JSON-QUEBRADO'));
    });

    it('sem token ou com token inválido: 401; token de administrador da plataforma: 403', async () => {
      const companyId = await createCompany('post-401');
      const calls: readonly [string, string][] = [
        ['POST', `/admin/companies/${companyId}/messages`],
        ['GET', `/admin/companies/${companyId}/conversations`],
        ['GET', `/admin/companies/${companyId}/conversations/${randomUUID()}/messages`],
      ];
      for (const [method, url] of calls) {
        const platform = auth;
        for (const headers of [{}, { authorization: 'Bearer errada' }, platform]) {
          const response = await app.inject({
            method: method as 'GET' | 'POST',
            url,
            headers,
            payload: method === 'POST' ? { contactRef: 'c', text: 'oi' } : undefined,
          });
          assert.equal(response.statusCode, headers === platform ? 403 : 401, `${method} ${url}`);
        }
      }
    });
  });

  describe('GET conversations e messages', () => {
    it('expõe sentAt: nulo na resposta não enviada (simulador) e ISO depois da marca de envio', async () => {
      const companyId = await createCompany('get-sent');
      const first = await send(companyId, { contactRef: 'c1', text: 'um' });
      const { conversationId } = first.json<ReplyBody>();
      const list = async () =>
        (
          await app.inject({
            method: 'GET',
            url: `/admin/companies/${companyId}/conversations/${conversationId}/messages`,
            headers: as(companyId),
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
      const marked = await store.messages.markSent(CompanyId.parse(companyId), reply.id, {
        channelMessageId: 'wamid.out',
        sentAt,
      });
      assert.equal(marked, true);
      const after = await list();
      assert.equal(after[0]?.sentAt, null);
      assert.equal(after[1]?.sentAt, sentAt.toISOString());
    });

    it('lista conversas e o histórico em ordem cronológica, com paginação', async () => {
      const companyId = await createCompany('get-ok');
      const first = await send(companyId, { contactRef: 'c1', text: 'um', externalId: 'e1' });
      await send(companyId, { contactRef: 'c1', text: 'dois' });
      await send(companyId, { contactRef: 'c2', text: 'tres' });
      const { conversationId } = first.json<ReplyBody>();

      const conversations = await app.inject({
        method: 'GET',
        url: `/admin/companies/${companyId}/conversations?limit=1`,
        headers: as(companyId),
      });
      assert.equal(conversations.statusCode, 200);
      const page = conversations.json<PageBody<{ id: string; contactRef: string }>>();
      assert.equal(page.items.length, 1);
      assert.equal(page.items[0]?.id, conversationId);
      assert.equal(page.items[0].contactRef, 'c1');
      assert.notEqual(page.nextCursor, null);
      const next = await app.inject({
        method: 'GET',
        url: `/admin/companies/${companyId}/conversations?limit=1&cursor=${page.nextCursor ?? ''}`,
        headers: as(companyId),
      });
      assert.equal(next.json<PageBody<{ contactRef: string }>>().items[0]?.contactRef, 'c2');

      const messages = await app.inject({
        method: 'GET',
        url: `/admin/companies/${companyId}/conversations/${conversationId}/messages`,
        headers: as(companyId),
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
        url: `/admin/companies/${companyId}/conversations/${conversationId}/messages?limit=3`,
        headers: as(companyId),
      });
      assert.equal(paged.json<PageBody<MessageBody>>().items.length, 3);
      assert.notEqual(paged.json<PageBody<MessageBody>>().nextCursor, null);
    });

    it('conversa de outra empresa: 404; conversationId malformado: 400; :companyId diferente do token: 404', async () => {
      const a = await createCompany('get-iso-a');
      const b = await createCompany('get-iso-b');
      const sentB = await send(b, { contactRef: 'mesmo', text: 'segredo-do-B' });
      await send(a, { contactRef: 'mesmo', text: 'texto-do-A' });
      const conversationB = sentB.json<ReplyBody>().conversationId;

      const cross = await app.inject({
        method: 'GET',
        url: `/admin/companies/${a}/conversations/${conversationB}/messages`,
        headers: as(a),
      });
      assert.equal(cross.statusCode, 404);
      assert.ok(!cross.body.includes('segredo-do-B'));

      const listA = await app.inject({
        method: 'GET',
        url: `/admin/companies/${a}/conversations`,
        headers: as(a),
      });
      assert.ok(!listA.body.includes(conversationB));

      for (const url of [
        `/admin/companies/${a}/conversations/nao-uuid/messages`,
        `/admin/companies/${a}/conversations?limit=0`,
        `/admin/companies/${a}/conversations?limit=201`,
        `/admin/companies/${a}/conversations?cursor=lixo`,
      ]) {
        const response = await app.inject({ method: 'GET', url, headers: as(a) });
        assert.equal(response.statusCode, 400, url);
      }
      // `:companyId` que não é o do token: 404 (também para id malformado), sem tocar em dados.
      for (const other of [randomUUID(), 'nao-uuid', b]) {
        const ghost = await app.inject({
          method: 'GET',
          url: `/admin/companies/${other}/conversations`,
          headers: as(a),
        });
        assert.equal(ghost.statusCode, 404, other);
        assert.ok(!ghost.body.includes('segredo-do-B'));
      }
    });
  });

  describe('contexto de log', () => {
    it('as linhas do log da requisição levam o companyId do path', async () => {
      const companyId = await createCompany('log-ctx');
      const response = await send(companyId, { contactRef: 'c1', text: 'oi' });
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
          companyId: line.companyId,
          keys: Object.keys(line).sort(),
        })),
      );
      assert.ok(mine.length >= 2, `log do atendimento e log da requisição: ${diagnosis}`);
      for (const line of mine) {
        assert.equal(line.companyId, companyId, `linha sem o companyId do path: ${diagnosis}`);
      }
      assert.ok(
        mine.some((line) => line.msg === 'requisição concluída'),
        `falta o log de fim da requisição: ${diagnosis}`,
      );
    });
  });
});
