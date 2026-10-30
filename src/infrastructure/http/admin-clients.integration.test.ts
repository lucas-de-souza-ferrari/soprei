import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { ClientService } from '../../application/clients/client.service.js';
import { ClientId } from '../../domain/index.js';
import { ConflictError } from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import { bearer, buildTestAuth } from '../../test-support/in-memory-auth.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import { createDatabase, PrismaClientRepository, type Database } from '../database/index.js';
import { createLogger } from '../logger/logger.js';
import { buildServer } from './server.js';

const config = loadIntegrationConfig();
const logger = createLogger(config);
// Token de um `PlatformAdmin` de teste (login em memória, só na memória do processo de teste).
let auth: { authorization: string };

interface ClientBody {
  id: string;
  slug: string;
  name: string;
  status: string;
}

let database: Database;
let tenants: TestTenants;
let app: FastifyInstance;

const slug = (label: string): string => `${label}-${randomBytes(6).toString('hex')}`;

before(async () => {
  database = createDatabase(config, logger);
  tenants = new TestTenants(database.prisma);
  const testAuth = buildTestAuth({ logger });
  auth = bearer((await testAuth.platformToken()).accessToken);
  app = buildServer({
    logger,
    readiness: {
      database: () => database.check(),
      redis: () => Promise.resolve(Result.ok(undefined)),
    },
    auth: testAuth.service,
    admin: {
      clients: new ClientService(new PrismaClientRepository(database.prisma)),
    },
  });
  // Rota só do teste: um bug de programação (consulta de tenant sem escopo) chegando ao HTTP.
  app.get('/test/sem-escopo', () => database.prisma.conversation.findMany({}));
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

async function post(body: unknown): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/admin/clients',
    headers: auth,
    payload: body as object,
  });
}

describe('/admin/clients contra o PostgreSQL de testes', () => {
  it('CRUD completo: cria, busca, lista, atualiza e remove (soft delete)', async () => {
    const wanted = slug('crud');
    const created = await post({ name: 'Cliente CRUD', slug: wanted });
    assert.equal(created.statusCode, 201);
    const client = created.json<ClientBody>();
    tenants.track(client.id);

    const got = await app.inject({
      method: 'GET',
      url: `/admin/clients/${client.id}`,
      headers: auth,
    });
    assert.equal(got.statusCode, 200);
    assert.equal(got.json<ClientBody>().slug, wanted);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/admin/clients/${client.id}`,
      headers: auth,
      payload: { status: 'SUSPENDED' },
    });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json<ClientBody>().status, 'SUSPENDED');

    const list = await app.inject({
      method: 'GET',
      url: '/admin/clients?limit=200',
      headers: auth,
    });
    assert.equal(list.statusCode, 200);
    const { items } = list.json<{ items: ClientBody[] }>();
    assert.ok(items.length >= 1);
    assert.ok(items.every((item) => typeof item.slug === 'string'));

    const removed = await app.inject({
      method: 'DELETE',
      url: `/admin/clients/${client.id}`,
      headers: auth,
    });
    assert.equal(removed.statusCode, 204);
    const after = await app.inject({
      method: 'GET',
      url: `/admin/clients/${client.id}`,
      headers: auth,
    });
    assert.equal(after.statusCode, 404);

    // Slug reservado para sempre, mesmo depois do soft delete.
    assert.equal((await post({ name: 'Reuso', slug: wanted })).statusCode, 409);
  });

  it('pedidos simultâneos com o mesmo slug: um 201 e os demais 409 (unicidade é do banco)', async () => {
    const shared = slug('race');
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        post({ name: `Concorrente ${String(index)}`, slug: shared }),
      ),
    );
    for (const response of responses) {
      if (response.statusCode === 201) tenants.track(response.json<ClientBody>().id);
    }
    const statuses = responses.map((response) => response.statusCode).sort();
    assert.deepEqual(statuses, [201, 409, 409, 409, 409]);
    for (const response of responses.filter((candidate) => candidate.statusCode === 409)) {
      assert.equal(response.json<{ error: { code: string } }>().error.code, 'CONFLICT');
      assert.ok(!response.body.toLowerCase().includes('unique'));
      assert.ok(!response.body.includes('clients'));
    }
  });

  it('401 sem chave e com chave errada, também contra o banco real', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/admin/clients' })).statusCode, 401);
    const wrong = await app.inject({
      method: 'GET',
      url: '/admin/clients',
      headers: { authorization: 'Bearer errada' },
    });
    assert.equal(wrong.statusCode, 401);
  });

  it('TenantScopeError não vaza detalhes: 500 genérico, sem model, operação nem SQL', async () => {
    const response = await app.inject({ method: 'GET', url: '/test/sem-escopo' });
    assert.equal(response.statusCode, 500);
    const body = response.json<{ error: { code: string; message: string } }>();
    assert.equal(body.error.code, 'TENANT_SCOPE_ERROR');
    assert.equal(body.error.message, 'Erro interno do servidor');
    for (const leaked of ['Conversation', 'findMany', 'clientId', 'SELECT', 'where']) {
      assert.ok(!response.body.includes(leaked), leaked);
    }
  });
});

describe('whatsappPhoneNumberId: único no banco e fora do PATCH (specs 011 e 015)', () => {
  const phoneNumber = (): string =>
    `8${randomBytes(6).readUIntBE(0, 6).toString().padStart(15, '0')}`;

  it('o PATCH recusa o campo (400); o @unique do banco continua sendo a barreira entre clientes', async () => {
    const first = (await post({ name: 'WA um', slug: slug('wa1') })).json<ClientBody>();
    const second = (await post({ name: 'WA dois', slug: slug('wa2') })).json<ClientBody>();
    tenants.track(first.id);
    tenants.track(second.id);
    const number = phoneNumber();
    const patch = (id: string, payload: object): Promise<LightMyRequestResponse> =>
      app.inject({ method: 'PATCH', url: `/admin/clients/${id}`, headers: auth, payload });
    assert.equal((await patch(first.id, { whatsappPhoneNumberId: number })).statusCode, 400);

    // O número só entra pelo repositório (o canal do cliente, spec 015, o usa numa transação).
    const repository = new PrismaClientRepository(database.prisma);
    const firstId = ClientId.parse(first.id);
    const secondId = ClientId.parse(second.id);
    await repository.update(firstId, { whatsappPhoneNumberId: number });
    const read = await app.inject({
      method: 'GET',
      url: `/admin/clients/${first.id}`,
      headers: auth,
    });
    assert.equal(read.json<{ whatsappPhoneNumberId: string }>().whatsappPhoneNumberId, number);
    await assert.rejects(
      repository.update(secondId, { whatsappPhoneNumberId: number }),
      (error: unknown) => error instanceof ConflictError,
    );
    // Remover o cliente libera o número para outro.
    await app.inject({ method: 'DELETE', url: `/admin/clients/${first.id}`, headers: auth });
    const moved = await repository.update(secondId, { whatsappPhoneNumberId: number });
    assert.equal(moved.whatsappPhoneNumberId, number);
  });
});
