import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { ClientId } from '../../../domain/index.js';
import { TenantScopeError } from '../../../shared/errors/index.js';
import { loadIntegrationConfig } from '../../../test-support/integration-env.js';
import { captureLogs } from '../../../test-support/log-capture.js';
import { TestTenants } from '../../../test-support/tenant-fixtures.js';
import { createDatabase, type Database } from '../database.js';
import { PrismaAuditRepository } from './audit.repository.js';
import { PrismaChannelConnectionRepository } from './channel-connection.repository.js';

const config = loadIntegrationConfig();
let database: Database;
let tenants: TestTenants;
let repository: PrismaChannelConnectionRepository;

before(() => {
  database = createDatabase(config, captureLogs().logger);
  tenants = new TestTenants(database.prisma);
  repository = new PrismaChannelConnectionRepository(database.prisma);
});

after(async () => {
  try {
    await tenants.cleanup();
  } finally {
    await database.close();
  }
});

const newConnection = (suffix: string) => ({
  wabaId: '123456',
  tokenCiphertext: `v1.teste.${suffix}.tag.corpo`,
  tokenExpiresAt: null,
});

describe('PrismaChannelConnectionRepository (spec 015, isolamento entre clientes)', () => {
  it('uma conexão por cliente: save cria e depois troca (versão +1, volta a CONNECTED); A nunca enxerga B', async () => {
    const a = await tenants.createClient('conn-a');
    const b = await tenants.createClient('conn-b');
    const first = await repository.save(a.id, newConnection('a1'));
    assert.equal(first.replaced, false);
    assert.equal(first.connection.tokenVersion, 1);
    await repository.save(b.id, newConnection('b1'));

    assert.equal(await repository.markTokenInvalid(a.id, 1, new Date()), true);
    const replaced = await repository.save(a.id, newConnection('a2'));
    assert.equal(replaced.replaced, true);
    assert.equal(replaced.connection.tokenVersion, 2);
    assert.equal(replaced.connection.status, 'CONNECTED');
    assert.equal(replaced.connection.tokenInvalidAt, null);
    assert.equal(replaced.connection.tokenCiphertext, 'v1.teste.a2.tag.corpo');

    assert.equal((await repository.find(a.id))?.tokenCiphertext, 'v1.teste.a2.tag.corpo');
    assert.equal((await repository.find(b.id))?.tokenCiphertext, 'v1.teste.b1.tag.corpo');
    assert.equal(await repository.count(a.id), 1);
    assert.equal((await repository.list(a.id)).items.length, 1);
    // Id de B pelo cliente A: inexistente.
    const idOfB = (await repository.find(b.id))?.id ?? '';
    await assert.rejects(repository.findById(a.id, idOfB), { name: 'NotFoundError' });
  });

  it('markTokenInvalid é condicional à versão e ao cliente; removeByClient só apaga o do cliente', async () => {
    const a = await tenants.createClient('mark-a');
    const b = await tenants.createClient('mark-b');
    await repository.save(a.id, newConnection('a'));
    await repository.save(b.id, newConnection('b'));

    assert.equal(await repository.markTokenInvalid(a.id, 99, new Date()), false, 'versão antiga');
    assert.equal((await repository.find(a.id))?.status, 'CONNECTED');
    assert.equal(await repository.markTokenInvalid(a.id, 1, new Date()), true);
    assert.equal(await repository.markTokenInvalid(a.id, 1, new Date()), false, 'já inválida');
    assert.equal((await repository.find(b.id))?.status, 'CONNECTED', 'B não é afetado');

    assert.equal(await repository.removeByClient(a.id), true);
    assert.equal(await repository.removeByClient(a.id), false);
    assert.equal(await repository.find(a.id), null);
    assert.ok((await repository.find(b.id)) !== null);
  });

  it('a tenant-scope recusa operação sem clientId e as operações por chave única', async () => {
    const { channelConnection } = database.prisma;
    await assert.rejects(channelConnection.findMany({ where: {} }), TenantScopeError);
    await assert.rejects(channelConnection.deleteMany({ where: {} }), TenantScopeError);
    await assert.rejects(
      channelConnection.findUnique({ where: { id: randomUUID() } }),
      TenantScopeError,
    );
    await assert.rejects(
      channelConnection.create({ data: { wabaId: '1', tokenCiphertext: 'x' } as never }),
      TenantScopeError,
    );
  });

  it('o clientId é único no banco e o CHECK da auditoria exige alvo nas ações USER_* e proíbe nas CHANNEL_*', async () => {
    const client = await tenants.createClient('check');
    await repository.save(client.id, newConnection('x'));
    await assert.rejects(
      database.prisma.channelConnection.create({
        data: { clientId: client.id, wabaId: '1', tokenCiphertext: 'y' },
      }),
    );

    const user = await database.prisma.user.create({
      data: { clientId: client.id, email: `${randomUUID()}@check.test`, passwordHash: 'x' },
    });
    const audit = new PrismaAuditRepository(database.prisma);
    const id = ClientId.parse(client.id);
    await audit.create(id, { action: 'CHANNEL_CONNECTED', actorUserId: user.id });
    await audit.create(id, {
      action: 'USER_CREATED',
      actorUserId: user.id,
      targetUserId: user.id,
    });
    await assert.rejects(audit.create(id, { action: 'USER_CREATED', actorUserId: user.id }));
    await assert.rejects(
      audit.create(id, {
        action: 'CHANNEL_DISCONNECTED',
        actorUserId: user.id,
        targetUserId: user.id,
      }),
    );
  });
});
