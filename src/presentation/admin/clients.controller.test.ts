import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ClientService } from '../../application/clients/client.service.js';
import { buildTestServer } from '../../infrastructure/http/test-server.js';
import { createLogger } from '../../infrastructure/logger/logger.js';
import { bearer, buildTestAuth, type TestAuth } from '../../test-support/in-memory-auth.js';
import { InMemoryClientRepository } from '../../test-support/in-memory-client.repository.js';

// Tokens emitidos por logins de verdade (autenticação em memória), só deste arquivo.
const testAuth = buildTestAuth({ logger: createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }) });
let auth: { authorization: string };

interface ClientBody {
  id: string;
  name: string;
  slug: string;
  status: string;
  persona: string | null;
  whatsappPhoneNumberId: string | null;
  createdAt: string;
  updatedAt: string;
}
interface ErrorBody {
  error: { code: string; message: string; details?: unknown[] };
}

function buildApp(source: TestAuth): FastifyInstance {
  return buildTestServer(
    undefined,
    { clients: new ClientService(new InMemoryClientRepository()) },
    { auth: source.service },
  );
}

describe('rotas /admin/clients', () => {
  let app: FastifyInstance;

  before(async () => {
    app = buildApp(testAuth);
    await app.ready();
    auth = bearer((await testAuth.platformToken()).accessToken);
  });
  after(async () => {
    await app.close();
  });

  async function createClient(slug: string, name = 'Cliente Teste'): Promise<ClientBody> {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/clients',
      headers: auth,
      payload: { name, slug },
    });
    assert.equal(response.statusCode, 201);
    return response.json<ClientBody>();
  }

  describe('CRUD com o token do administrador da plataforma', () => {
    it('POST cria (201) e devolve só campos seguros', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/admin/clients',
        headers: auth,
        payload: { name: ' Acme ', slug: 'acme-crud' },
      });
      assert.equal(response.statusCode, 201);
      const body = response.json<ClientBody>();
      assert.deepEqual(Object.keys(body).sort(), [
        'createdAt',
        'id',
        'name',
        'persona',
        'slug',
        'status',
        'updatedAt',
        'whatsappPhoneNumberId',
      ]);
      assert.equal(body.name, 'Acme');
      assert.equal(body.status, 'ACTIVE');
      assert.ok(!Number.isNaN(Date.parse(body.createdAt)));
    });

    it('GET /:id devolve o cliente; GET / lista com paginação', async () => {
      const created = await createClient('acme-get');
      const one = await app.inject({
        method: 'GET',
        url: `/admin/clients/${created.id}`,
        headers: auth,
      });
      assert.equal(one.statusCode, 200);
      assert.deepEqual(one.json(), created);

      const list = await app.inject({
        method: 'GET',
        url: '/admin/clients?limit=1',
        headers: auth,
      });
      assert.equal(list.statusCode, 200);
      const page = list.json<{ items: ClientBody[]; nextCursor: string | null }>();
      assert.equal(page.items.length, 1);
      assert.ok(page.nextCursor !== null);
      const next = await app.inject({
        method: 'GET',
        url: `/admin/clients?limit=1&cursor=${page.nextCursor}`,
        headers: auth,
      });
      assert.equal(next.statusCode, 200);
    });

    it('PATCH define a persona (com trim), a devolve no GET e null a limpa', async () => {
      const created = await createClient('acme-persona');
      assert.equal(created.persona, null);

      const set = await app.inject({
        method: 'PATCH',
        url: `/admin/clients/${created.id}`,
        headers: auth,
        payload: { persona: '  Você é a Ana, atendente da Acme.  ' },
      });
      assert.equal(set.statusCode, 200);
      assert.equal(set.json<ClientBody>().persona, 'Você é a Ana, atendente da Acme.');
      const read = await app.inject({
        method: 'GET',
        url: `/admin/clients/${created.id}`,
        headers: auth,
      });
      assert.equal(read.json<ClientBody>().persona, 'Você é a Ana, atendente da Acme.');

      // Persona mexe só na persona: o resto fica como estava.
      assert.equal(set.json<ClientBody>().name, created.name);
      assert.equal(set.json<ClientBody>().status, 'ACTIVE');

      const cleared = await app.inject({
        method: 'PATCH',
        url: `/admin/clients/${created.id}`,
        headers: auth,
        payload: { persona: null },
      });
      assert.equal(cleared.statusCode, 200);
      assert.equal(cleared.json<ClientBody>().persona, null);
    });

    it('PATCH define o whatsappPhoneNumberId, o devolve no GET e null o limpa (spec 011)', async () => {
      const created = await createClient('acme-wa');
      assert.equal(created.whatsappPhoneNumberId, null);

      const set = await app.inject({
        method: 'PATCH',
        url: `/admin/clients/${created.id}`,
        headers: auth,
        payload: { whatsappPhoneNumberId: '106540352242922' },
      });
      assert.equal(set.statusCode, 200);
      assert.equal(set.json<ClientBody>().whatsappPhoneNumberId, '106540352242922');
      assert.equal(set.json<ClientBody>().name, created.name);
      const read = await app.inject({
        method: 'GET',
        url: `/admin/clients/${created.id}`,
        headers: auth,
      });
      assert.equal(read.json<ClientBody>().whatsappPhoneNumberId, '106540352242922');

      const cleared = await app.inject({
        method: 'PATCH',
        url: `/admin/clients/${created.id}`,
        headers: auth,
        payload: { whatsappPhoneNumberId: null },
      });
      assert.equal(cleared.statusCode, 200);
      assert.equal(cleared.json<ClientBody>().whatsappPhoneNumberId, null);
    });

    it('PATCH recusa número com formato inválido (400) e número já usado por outro cliente (409)', async () => {
      const first = await createClient('acme-wa-1');
      const second = await createClient('acme-wa-2');
      for (const invalid of ['', 'abc', '12 34', '+5511999999999', '1'.repeat(33), 123]) {
        const response = await app.inject({
          method: 'PATCH',
          url: `/admin/clients/${first.id}`,
          headers: auth,
          payload: { whatsappPhoneNumberId: invalid },
        });
        assert.equal(response.statusCode, 400, String(invalid));
      }
      const ok = await app.inject({
        method: 'PATCH',
        url: `/admin/clients/${first.id}`,
        headers: auth,
        payload: { whatsappPhoneNumberId: '555000111' },
      });
      assert.equal(ok.statusCode, 200);
      const conflict = await app.inject({
        method: 'PATCH',
        url: `/admin/clients/${second.id}`,
        headers: auth,
        payload: { whatsappPhoneNumberId: '555000111' },
      });
      assert.equal(conflict.statusCode, 409);
      assert.equal(conflict.json<ErrorBody>().error.code, 'CONFLICT');
    });

    it('persona de 4000 caracteres é aceita', async () => {
      const created = await createClient('acme-persona-max');
      const response = await app.inject({
        method: 'PATCH',
        url: `/admin/clients/${created.id}`,
        headers: auth,
        payload: { persona: 'p'.repeat(4000) },
      });
      assert.equal(response.statusCode, 200);
    });

    it('PATCH atualiza nome e status; DELETE remove (204) e depois é 404', async () => {
      const created = await createClient('acme-upd');
      const patched = await app.inject({
        method: 'PATCH',
        url: `/admin/clients/${created.id}`,
        headers: auth,
        payload: { name: 'Novo Nome', status: 'SUSPENDED' },
      });
      assert.equal(patched.statusCode, 200);
      assert.equal(patched.json<ClientBody>().name, 'Novo Nome');
      assert.equal(patched.json<ClientBody>().status, 'SUSPENDED');
      assert.equal(patched.json<ClientBody>().slug, 'acme-upd');

      // Cliente suspenso continua legível e editável pelo CRUD.
      const read = await app.inject({
        method: 'GET',
        url: `/admin/clients/${created.id}`,
        headers: auth,
      });
      assert.equal(read.statusCode, 200);

      const deleted = await app.inject({
        method: 'DELETE',
        url: `/admin/clients/${created.id}`,
        headers: auth,
      });
      assert.equal(deleted.statusCode, 204);
      assert.equal(deleted.body, '');

      for (const method of ['GET', 'DELETE'] as const) {
        const gone = await app.inject({
          method,
          url: `/admin/clients/${created.id}`,
          headers: auth,
        });
        assert.equal(gone.statusCode, 404, method);
        assert.equal(gone.json<ErrorBody>().error.code, 'NOT_FOUND');
      }
      const patchGone = await app.inject({
        method: 'PATCH',
        url: `/admin/clients/${created.id}`,
        headers: auth,
        payload: { name: 'x' },
      });
      assert.equal(patchGone.statusCode, 404);
    });
  });

  describe('autenticação (401)', () => {
    const routes = [
      { method: 'POST', url: '/admin/clients', payload: { name: 'X', slug: 'sem-auth' } },
      { method: 'GET', url: '/admin/clients' },
      { method: 'GET', url: `/admin/clients/${randomUUID()}` },
      { method: 'PATCH', url: `/admin/clients/${randomUUID()}`, payload: { name: 'X' } },
      { method: 'DELETE', url: `/admin/clients/${randomUUID()}` },
    ] as const;

    it('sem cabeçalho Authorization: 401 em todas as rotas', async () => {
      for (const route of routes) {
        const response = await app.inject(route);
        assert.equal(response.statusCode, 401, `${route.method} ${route.url}`);
        assert.equal(response.json<ErrorBody>().error.code, 'UNAUTHORIZED');
      }
    });

    it('com token inválido, esquema errado ou Bearer malformado: 401 com WWW-Authenticate', async () => {
      const valid = auth.authorization.slice('Bearer '.length);
      for (const authorization of [
        'Bearer token-errado',
        `Bearer ${valid}x`,
        `Basic ${valid}`,
        valid,
        'Bearer',
        'Bearer ',
        `Bearer  ${valid}`,
      ]) {
        const response = await app.inject({
          method: 'GET',
          url: '/admin/clients',
          headers: { authorization },
        });
        assert.equal(response.statusCode, 401, authorization);
        assert.equal(response.headers['www-authenticate'], 'Bearer');
      }
    });

    it('a resposta 401 é igual com cabeçalho ausente e com token errado (não revela qual)', async () => {
      const missing = await app.inject({ method: 'GET', url: '/admin/clients' });
      const wrong = await app.inject({
        method: 'GET',
        url: '/admin/clients',
        headers: { authorization: 'Bearer a.b.c' },
      });
      assert.equal(missing.json<ErrorBody>().error.message, wrong.json<ErrorBody>().error.message);
      assert.ok(!wrong.body.includes('a.b.c'));
    });

    it('aceita o esquema Bearer em qualquer caixa', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/clients',
        headers: { authorization: `bearer ${auth.authorization.slice('Bearer '.length)}` },
      });
      assert.equal(response.statusCode, 200);
    });

    it('token de User (de cliente) recebe 403 em todas as rotas /admin/clients', async () => {
      const client = await testAuth.clients.create({ name: 'Cliente X', slug: 'cliente-x-403' });
      const user = bearer((await testAuth.userToken(client.id)).accessToken);
      for (const route of routes) {
        const response = await app.inject({ ...route, headers: user });
        assert.equal(response.statusCode, 403, `${route.method} ${route.url}`);
        assert.equal(response.json<ErrorBody>().error.code, 'FORBIDDEN');
      }
    });

    it('rotas /admin não existem quando o servidor sobe sem o módulo admin', async () => {
      const bare = buildTestServer();
      try {
        const response = await bare.inject({ method: 'GET', url: '/admin/clients', headers: auth });
        assert.equal(response.statusCode, 404);
      } finally {
        await bare.close();
      }
    });
  });

  describe('validação e erros', () => {
    it(':id inválido é 400 em GET, PATCH e DELETE', async () => {
      for (const id of [
        'abc',
        '123',
        'zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz',
        randomUUID().slice(1),
      ]) {
        for (const [method, payload] of [
          ['GET', undefined],
          ['PATCH', { name: 'x' }],
          ['DELETE', undefined],
        ] as const) {
          const response = await app.inject({
            method,
            url: `/admin/clients/${id}`,
            headers: auth,
            ...(payload === undefined ? {} : { payload }),
          });
          assert.equal(response.statusCode, 400, `${method} ${id}`);
          assert.equal(response.json<ErrorBody>().error.code, 'VALIDATION_ERROR');
        }
      }
    });

    it('id válido mas inexistente é 404', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/admin/clients/${randomUUID()}`,
        headers: auth,
      });
      assert.equal(response.statusCode, 404);
    });

    it('slug inválido é 400', async () => {
      for (const slug of [
        'ab',
        'a'.repeat(64),
        'Maiuscula',
        'com espaco',
        'com_underscore',
        '',
        'ação',
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: '/admin/clients',
          headers: auth,
          payload: { name: 'X', slug },
        });
        assert.equal(response.statusCode, 400, slug);
        assert.equal(response.json<ErrorBody>().error.code, 'VALIDATION_ERROR');
      }
    });

    it('corpo inválido é 400: campos faltando, status desconhecido, chave extra, sem corpo', async () => {
      for (const payload of [
        {},
        { name: 'X' },
        { slug: 'sem-nome' },
        { name: '', slug: 'nome-vazio' },
        { name: 'x'.repeat(121), slug: 'nome-longo' },
        { name: 'X', slug: 'status-ruim', status: 'DELETED' },
        { name: 'X', slug: 'extra-key', clientId: randomUUID() },
        { name: 'X', slug: 'deleted-at', deletedAt: '2020-01-01' },
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: '/admin/clients',
          headers: auth,
          payload,
        });
        assert.equal(response.statusCode, 400, JSON.stringify(payload));
      }
      const noBody = await app.inject({ method: 'POST', url: '/admin/clients', headers: auth });
      assert.equal(noBody.statusCode, 400);
    });

    it('PATCH exige name, status ou persona e não aceita slug nem persona inválida', async () => {
      const created = await createClient('acme-patch400');
      for (const payload of [
        {},
        { slug: 'outro-slug' },
        { status: 'X' },
        { name: '' },
        { persona: '' },
        { persona: '   ' },
        { persona: 'p'.repeat(4001) },
        { persona: 42 },
        { persona: 'com\u0000nul' },
      ]) {
        const response = await app.inject({
          method: 'PATCH',
          url: `/admin/clients/${created.id}`,
          headers: auth,
          payload,
        });
        assert.equal(response.statusCode, 400, JSON.stringify(payload));
      }
    });

    it('slug duplicado é 409, inclusive de cliente removido', async () => {
      const created = await createClient('acme-dup');
      const again = await app.inject({
        method: 'POST',
        url: '/admin/clients',
        headers: auth,
        payload: { name: 'Outro', slug: 'acme-dup' },
      });
      assert.equal(again.statusCode, 409);
      assert.equal(again.json<ErrorBody>().error.code, 'CONFLICT');

      await app.inject({ method: 'DELETE', url: `/admin/clients/${created.id}`, headers: auth });
      const reuse = await app.inject({
        method: 'POST',
        url: '/admin/clients',
        headers: auth,
        payload: { name: 'Reuso', slug: 'acme-dup' },
      });
      assert.equal(reuse.statusCode, 409);
    });

    it('limit fora do intervalo ou cursor inválido na listagem é 400', async () => {
      for (const query of [
        'limit=0',
        'limit=201',
        'limit=abc',
        'limit=1.5',
        'limit=',
        'cursor=',
        'cursor=lixo&x=1',
        'extra=1',
      ]) {
        const response = await app.inject({
          method: 'GET',
          url: `/admin/clients?${query}`,
          headers: auth,
        });
        assert.equal(response.statusCode, 400, query);
      }
    });

    it('listagem de removidos: some da lista', async () => {
      const created = await createClient('acme-list-del');
      await app.inject({ method: 'DELETE', url: `/admin/clients/${created.id}`, headers: auth });
      const list = await app.inject({
        method: 'GET',
        url: '/admin/clients?limit=200',
        headers: auth,
      });
      const slugs = list.json<{ items: ClientBody[] }>().items.map((client) => client.slug);
      assert.ok(!slugs.includes('acme-list-del'));
    });
  });
});
