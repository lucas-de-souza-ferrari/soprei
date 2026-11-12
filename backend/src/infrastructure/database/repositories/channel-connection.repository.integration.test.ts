import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { CompanyId } from '../../../domain/index.js';
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
  mode: 'API_ONLY' as const,
});

describe('PrismaChannelConnectionRepository (spec 015, isolamento entre empresas)', () => {
  it('uma conexão por empresa: save cria e depois troca (versão +1, volta a CONNECTED); A nunca enxerga B', async () => {
    const a = await tenants.createCompany('conn-a');
    const b = await tenants.createCompany('conn-b');
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
    // Id de B pela empresa A: inexistente.
    const idOfB = (await repository.find(b.id))?.id ?? '';
    await assert.rejects(repository.findById(a.id, idOfB), { name: 'NotFoundError' });
  });

  it('markTokenInvalid é condicional à versão e à empresa; removeByCompany só apaga o da empresa', async () => {
    const a = await tenants.createCompany('mark-a');
    const b = await tenants.createCompany('mark-b');
    await repository.save(a.id, newConnection('a'));
    await repository.save(b.id, newConnection('b'));

    assert.equal(await repository.markTokenInvalid(a.id, 99, new Date()), false, 'versão antiga');
    assert.equal((await repository.find(a.id))?.status, 'CONNECTED');
    assert.equal(await repository.markTokenInvalid(a.id, 1, new Date()), true);
    assert.equal(await repository.markTokenInvalid(a.id, 1, new Date()), false, 'já inválida');
    assert.equal((await repository.find(b.id))?.status, 'CONNECTED', 'B não é afetado');

    assert.equal(await repository.removeByCompany(a.id), true);
    assert.equal(await repository.removeByCompany(a.id), false);
    assert.equal(await repository.find(a.id), null);
    assert.ok((await repository.find(b.id)) !== null);
  });

  it('a tenant-scope recusa operação sem companyId e as operações por chave única', async () => {
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

  it('o companyId é único no banco e o CHECK da auditoria exige alvo nas ações MEMBERSHIP_* e proíbe nas CHANNEL_*', async () => {
    const company = await tenants.createCompany('check');
    await repository.save(company.id, newConnection('x'));
    await assert.rejects(
      database.prisma.channelConnection.create({
        data: { companyId: company.id, wabaId: '1', tokenCiphertext: 'y' },
      }),
    );

    const membership = await database.prisma.membership.create({
      data: { companyId: company.id, email: `${randomUUID()}@check.test`, passwordHash: 'x' },
    });
    const audit = new PrismaAuditRepository(database.prisma);
    const id = CompanyId.parse(company.id);
    await audit.create(id, { action: 'CHANNEL_CONNECTED', actorMembershipId: membership.id });
    await audit.create(id, {
      action: 'MEMBERSHIP_CREATED',
      actorMembershipId: membership.id,
      targetMembershipId: membership.id,
    });
    await assert.rejects(
      audit.create(id, { action: 'MEMBERSHIP_CREATED', actorMembershipId: membership.id }),
    );
    await assert.rejects(
      audit.create(id, {
        action: 'CHANNEL_DISCONNECTED',
        actorMembershipId: membership.id,
        targetMembershipId: membership.id,
      }),
    );
  });
});
