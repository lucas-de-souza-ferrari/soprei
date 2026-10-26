import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ClientService } from '../../application/client.service.js';
import { buildTestServer } from '../../infrastructure/http/test-server.js';
import { InMemoryClientRepository } from '../../test-support/in-memory-client.repository.js';

// Chaves descartáveis, só deste arquivo.
const KEY = `test-${randomUUID()}-${randomUUID()}`;
const auth = { authorization: `Bearer ${KEY}` };

interface ClientBody {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}
interface ErrorBody {
  error: { code: string; message: string; details?: unknown[] };
}

function buildApp(apiKey: string | undefined): FastifyInstance {
  return buildTestServer(undefined, {
    apiKey,
    clients: new ClientService(new InMemoryClientRepository()),
  });
}

describe('rotas /admin/clients', () => {
  let app: FastifyInstance;

  before(async () => {
    app = buildApp(KEY);
    await app.ready();
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

  describe('CRUD com a chave', () => {
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
        'slug',
        'status',
        'updatedAt',
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

    it('com chave errada, esquema errado, prefixo parcial ou chave com sufixo: 401', async () => {
      for (const authorization of [
        'Bearer chave-errada',
        `Bearer ${KEY}x`,
        `Bearer ${KEY.slice(0, -1)}`,
        `Basic ${KEY}`,
        KEY,
        'Bearer',
        'Bearer ',
        `Bearer  ${KEY}`,
      ]) {
        const response = await app.inject({
          method: 'GET',
          url: '/admin/clients',
          headers: { authorization },
        });
        assert.equal(response.statusCode, 401, authorization);
      }
    });

    it('a resposta 401 é igual com cabeçalho ausente e com chave errada (não revela qual)', async () => {
      const missing = await app.inject({ method: 'GET', url: '/admin/clients' });
      const wrong = await app.inject({
        method: 'GET',
        url: '/admin/clients',
        headers: { authorization: 'Bearer errada' },
      });
      assert.equal(missing.json<ErrorBody>().error.message, wrong.json<ErrorBody>().error.message);
      assert.ok(!missing.body.includes(KEY));
      assert.ok(!wrong.body.includes(KEY));
    });

    it('aceita o esquema Bearer em qualquer caixa', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/clients',
        headers: { authorization: `bearer ${KEY}` },
      });
      assert.equal(response.statusCode, 200);
    });

    it('ADMIN_API_KEY não configurada: 401 mesmo com cabeçalho Bearer, inclusive vazio', async () => {
      for (const apiKey of [undefined, '']) {
        const noKey = buildApp(apiKey);
        try {
          for (const authorization of [`Bearer ${KEY}`, 'Bearer undefined', 'Bearer ']) {
            const response = await noKey.inject({
              method: 'GET',
              url: '/admin/clients',
              headers: { authorization },
            });
            assert.equal(response.statusCode, 401, `${String(apiKey)} / ${authorization}`);
          }
        } finally {
          await noKey.close();
        }
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

    it('PATCH exige name ou status e não aceita slug', async () => {
      const created = await createClient('acme-patch400');
      for (const payload of [{}, { slug: 'outro-slug' }, { status: 'X' }, { name: '' }]) {
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
