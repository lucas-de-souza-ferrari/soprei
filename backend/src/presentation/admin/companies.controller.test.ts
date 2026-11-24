import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { CompanyService } from '../../application/companies/company.service.js';
import { CompanyId } from '../../domain/index.js';
import { buildTestServer } from '../../infrastructure/http/test-server.js';
import { createLogger } from '../../infrastructure/logger/logger.js';
import { bearer, buildTestAuth, type TestAuth } from '../../test-support/in-memory-auth.js';
import { InMemoryCompanyRepository } from '../../test-support/in-memory-company.repository.js';

// Tokens emitidos por logins de verdade (autenticação em memória), só deste arquivo.
const testAuth = buildTestAuth({ logger: createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }) });
let auth: { authorization: string };

interface CompanyBody {
  id: string;
  name: string;
  slug: string;
  status: string;
  hasPersona: boolean;
  whatsappPhoneNumberId: string | null;
  createdAt: string;
  updatedAt: string;
}
interface ErrorBody {
  error: { code: string; message: string; details?: unknown[] };
}

// O serviço fica à mão para gravar a persona pelo caminho da empresa (a plataforma não a grava, spec 044 D8).
const companyService = new CompanyService(new InMemoryCompanyRepository());

function buildApp(source: TestAuth): FastifyInstance {
  return buildTestServer(undefined, { companies: companyService }, { auth: source.service });
}

describe('rotas /admin/companies', () => {
  let app: FastifyInstance;

  before(async () => {
    app = buildApp(testAuth);
    await app.ready();
    auth = bearer((await testAuth.platformToken()).accessToken);
  });
  after(async () => {
    await app.close();
  });

  async function createCompany(slug: string, name = 'Empresa Teste'): Promise<CompanyBody> {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/companies',
      headers: auth,
      payload: { name, slug },
    });
    assert.equal(response.statusCode, 201);
    return response.json<CompanyBody>();
  }

  describe('CRUD com o token do administrador da plataforma', () => {
    it('POST cria (201) e devolve só campos seguros', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/admin/companies',
        headers: auth,
        payload: { name: ' Acme ', slug: 'acme-crud' },
      });
      assert.equal(response.statusCode, 201);
      const body = response.json<CompanyBody>();
      assert.deepEqual(Object.keys(body).sort(), [
        'createdAt',
        'hasPersona',
        'id',
        'name',
        'slug',
        'status',
        'updatedAt',
        'whatsappPhoneNumberId',
      ]);
      assert.equal(body.name, 'Acme');
      assert.equal(body.status, 'ACTIVE');
      assert.ok(!Number.isNaN(Date.parse(body.createdAt)));
    });

    it('GET /:id devolve a empresa; GET / lista com paginação', async () => {
      const created = await createCompany('acme-get');
      const one = await app.inject({
        method: 'GET',
        url: `/admin/companies/${created.id}`,
        headers: auth,
      });
      assert.equal(one.statusCode, 200);
      assert.deepEqual(one.json(), created);

      const list = await app.inject({
        method: 'GET',
        url: '/admin/companies?limit=1',
        headers: auth,
      });
      assert.equal(list.statusCode, 200);
      const page = list.json<{ items: CompanyBody[]; nextCursor: string | null }>();
      assert.equal(page.items.length, 1);
      assert.ok(page.nextCursor !== null);
      const next = await app.inject({
        method: 'GET',
        url: `/admin/companies?limit=1&cursor=${page.nextCursor}`,
        headers: auth,
      });
      assert.equal(next.statusCode, 200);
    });

    it('persona (spec 044, D8): a resposta traz só hasPersona, nunca o texto; o PATCH com persona é 400', async () => {
      const created = await createCompany('acme-persona');
      assert.equal(created.hasPersona, false);
      await companyService.setPersona(CompanyId.parse(created.id), 'PERSONA-SECRETA-D8');

      const read = await app.inject({
        method: 'GET',
        url: `/admin/companies/${created.id}`,
        headers: auth,
      });
      assert.equal(read.json<CompanyBody>().hasPersona, true);
      const list = await app.inject({ method: 'GET', url: '/admin/companies', headers: auth });
      for (const response of [read, list]) {
        assert.ok(!response.body.includes('PERSONA-SECRETA-D8'));
        assert.ok(!response.body.includes('"persona"'));
      }

      for (const persona of ['Outra persona', null, 'p'.repeat(4000)]) {
        const response = await app.inject({
          method: 'PATCH',
          url: `/admin/companies/${created.id}`,
          headers: auth,
          payload: { persona },
        });
        assert.equal(response.statusCode, 400, String(persona));
      }
      const withName = await app.inject({
        method: 'PATCH',
        url: `/admin/companies/${created.id}`,
        headers: auth,
        payload: { name: 'Outro', persona: 'x' },
      });
      assert.equal(withName.statusCode, 400);
      assert.equal(
        await companyService.getPersona(CompanyId.parse(created.id)),
        'PERSONA-SECRETA-D8',
      );
    });

    it('PATCH não aceita mais whatsappPhoneNumberId (spec 015): 400, o número só muda pelo canal da empresa', async () => {
      const created = await createCompany('acme-wa');
      assert.equal(created.whatsappPhoneNumberId, null);
      for (const value of ['106540352242922', null, 'abc']) {
        const response = await app.inject({
          method: 'PATCH',
          url: `/admin/companies/${created.id}`,
          headers: auth,
          payload: { whatsappPhoneNumberId: value },
        });
        assert.equal(response.statusCode, 400, String(value));
      }
      const withName = await app.inject({
        method: 'PATCH',
        url: `/admin/companies/${created.id}`,
        headers: auth,
        payload: { name: 'Outro nome', whatsappPhoneNumberId: '106540352242922' },
      });
      assert.equal(withName.statusCode, 400);
      const read = await app.inject({
        method: 'GET',
        url: `/admin/companies/${created.id}`,
        headers: auth,
      });
      assert.equal(read.json<CompanyBody>().whatsappPhoneNumberId, null);
      assert.equal(read.json<CompanyBody>().name, created.name);
    });

    it('PATCH atualiza o nome; DELETE remove (204) e depois é 404', async () => {
      const created = await createCompany('acme-upd');
      const patched = await app.inject({
        method: 'PATCH',
        url: `/admin/companies/${created.id}`,
        headers: auth,
        payload: { name: 'Novo Nome' },
      });
      assert.equal(patched.statusCode, 200);
      assert.equal(patched.json<CompanyBody>().name, 'Novo Nome');
      assert.equal(patched.json<CompanyBody>().status, 'ACTIVE');
      assert.equal(patched.json<CompanyBody>().slug, 'acme-upd');

      const read = await app.inject({
        method: 'GET',
        url: `/admin/companies/${created.id}`,
        headers: auth,
      });
      assert.equal(read.statusCode, 200);

      const deleted = await app.inject({
        method: 'DELETE',
        url: `/admin/companies/${created.id}`,
        headers: auth,
      });
      assert.equal(deleted.statusCode, 204);
      assert.equal(deleted.body, '');

      for (const method of ['GET', 'DELETE'] as const) {
        const gone = await app.inject({
          method,
          url: `/admin/companies/${created.id}`,
          headers: auth,
        });
        assert.equal(gone.statusCode, 404, method);
        assert.equal(gone.json<ErrorBody>().error.code, 'NOT_FOUND');
      }
      const patchGone = await app.inject({
        method: 'PATCH',
        url: `/admin/companies/${created.id}`,
        headers: auth,
        payload: { name: 'x' },
      });
      assert.equal(patchGone.statusCode, 404);
    });
  });

  describe('autenticação (401)', () => {
    const routes = [
      { method: 'POST', url: '/admin/companies', payload: { name: 'X', slug: 'sem-auth' } },
      { method: 'GET', url: '/admin/companies' },
      { method: 'GET', url: `/admin/companies/${randomUUID()}` },
      { method: 'PATCH', url: `/admin/companies/${randomUUID()}`, payload: { name: 'X' } },
      { method: 'DELETE', url: `/admin/companies/${randomUUID()}` },
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
          url: '/admin/companies',
          headers: { authorization },
        });
        assert.equal(response.statusCode, 401, authorization);
        assert.equal(response.headers['www-authenticate'], 'Bearer');
      }
    });

    it('a resposta 401 é igual com cabeçalho ausente e com token errado (não revela qual)', async () => {
      const missing = await app.inject({ method: 'GET', url: '/admin/companies' });
      const wrong = await app.inject({
        method: 'GET',
        url: '/admin/companies',
        headers: { authorization: 'Bearer a.b.c' },
      });
      assert.equal(missing.json<ErrorBody>().error.message, wrong.json<ErrorBody>().error.message);
      assert.ok(!wrong.body.includes('a.b.c'));
    });

    it('aceita o esquema Bearer em qualquer caixa', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/companies',
        headers: { authorization: `bearer ${auth.authorization.slice('Bearer '.length)}` },
      });
      assert.equal(response.statusCode, 200);
    });

    it('token de Membership (de empresa) recebe 403 em todas as rotas /admin/companies', async () => {
      const company = await testAuth.companies.create({ name: 'Empresa X', slug: 'empresa-x-403' });
      const membership = bearer((await testAuth.membershipToken(company.id)).accessToken);
      for (const route of routes) {
        const response = await app.inject({ ...route, headers: membership });
        assert.equal(response.statusCode, 403, `${route.method} ${route.url}`);
        assert.equal(response.json<ErrorBody>().error.code, 'FORBIDDEN');
      }
    });

    it('rotas /admin não existem quando o servidor sobe sem o módulo admin', async () => {
      const bare = buildTestServer();
      try {
        const response = await bare.inject({
          method: 'GET',
          url: '/admin/companies',
          headers: auth,
        });
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
            url: `/admin/companies/${id}`,
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
        url: `/admin/companies/${randomUUID()}`,
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
          url: '/admin/companies',
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
        { name: 'X', slug: 'extra-key', companyId: randomUUID() },
        { name: 'X', slug: 'deleted-at', deletedAt: '2020-01-01' },
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: '/admin/companies',
          headers: auth,
          payload,
        });
        assert.equal(response.statusCode, 400, JSON.stringify(payload));
      }
      const noBody = await app.inject({ method: 'POST', url: '/admin/companies', headers: auth });
      assert.equal(noBody.statusCode, 400);
    });

    it('PATCH exige name e não aceita slug, persona nem status (suspender é só pela plataforma)', async () => {
      const created = await createCompany('acme-patch400');
      for (const payload of [
        {},
        { slug: 'outro-slug' },
        { status: 'X' },
        { status: 'SUSPENDED' },
        { status: 'ACTIVE' },
        { name: 'Outro', status: 'SUSPENDED' },
        { name: '' },
        { persona: 'x' },
        { persona: 42 },
      ]) {
        const response = await app.inject({
          method: 'PATCH',
          url: `/admin/companies/${created.id}`,
          headers: auth,
          payload,
        });
        assert.equal(response.statusCode, 400, JSON.stringify(payload));
      }
    });

    it('slug duplicado é 409, inclusive de empresa removida', async () => {
      const created = await createCompany('acme-dup');
      const again = await app.inject({
        method: 'POST',
        url: '/admin/companies',
        headers: auth,
        payload: { name: 'Outro', slug: 'acme-dup' },
      });
      assert.equal(again.statusCode, 409);
      assert.equal(again.json<ErrorBody>().error.code, 'CONFLICT');

      await app.inject({ method: 'DELETE', url: `/admin/companies/${created.id}`, headers: auth });
      const reuse = await app.inject({
        method: 'POST',
        url: '/admin/companies',
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
          url: `/admin/companies?${query}`,
          headers: auth,
        });
        assert.equal(response.statusCode, 400, query);
      }
    });

    it('listagem de removidos: some da lista', async () => {
      const created = await createCompany('acme-list-del');
      await app.inject({ method: 'DELETE', url: `/admin/companies/${created.id}`, headers: auth });
      const list = await app.inject({
        method: 'GET',
        url: '/admin/companies?limit=200',
        headers: auth,
      });
      const slugs = list.json<{ items: CompanyBody[] }>().items.map((company) => company.slug);
      assert.ok(!slugs.includes('acme-list-del'));
    });
  });
});
