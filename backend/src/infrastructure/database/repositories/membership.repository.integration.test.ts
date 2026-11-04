import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  type Company,
  CompanyId,
  type NewMembership,
  type Membership,
} from '../../../domain/index.js';
import { ConflictError, NotFoundError, TenantScopeError } from '../../../shared/errors/index.js';
import { loadIntegrationConfig } from '../../../test-support/integration-env.js';
import { TestTenants } from '../../../test-support/tenant-fixtures.js';
import { createLogger } from '../../logger/logger.js';
import { createDatabase, type Database } from '../database.js';
import { PrismaPlatformAdminRepository } from './platform-admin.repository.js';
import { PrismaMembershipRepository } from './membership.repository.js';

const config = loadIntegrationConfig();
const HASH_A = 'scrypt$1024$8$1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA==';
const HASH_B = 'scrypt$1024$8$1$b3V0cm9zYWx0b3V0cm8=$b3V0cm9oYXNoYm91dHJvaGFzaGJvdXRybw==';

let database: Database;
let tenants: TestTenants;
let memberships: PrismaMembershipRepository;
let companyA: Company;
let companyB: Company;
let membershipA: Membership;
let membershipB: Membership;
const email = (label: string): string => `${label}-${randomBytes(5).toString('hex')}@exemplo.test`;
const sharedEmail = email('mesmo');

before(async () => {
  database = createDatabase(config, createLogger(config));
  tenants = new TestTenants(database.prisma);
  memberships = new PrismaMembershipRepository(database.prisma);
  companyA = await tenants.createCompany('usr-a');
  companyB = await tenants.createCompany('usr-b');
  membershipA = await memberships.create(companyA.id, { email: sharedEmail, passwordHash: HASH_A });
  membershipB = await memberships.create(companyB.id, {
    email: sharedEmail,
    passwordHash: HASH_B,
    role: 'OWNER',
  });
});

after(async () => {
  try {
    await tenants.cleanup();
  } finally {
    await database.close();
  }
});

describe('isolamento no repositório de Membership (empresas A e B)', () => {
  it('a empresa A não encontra o usuário de B: findById é NotFoundError, com o CompanyId de B funciona', async () => {
    await assert.rejects(memberships.findById(companyA.id, membershipB.id), NotFoundError);
    assert.equal((await memberships.findById(companyB.id, membershipB.id)).id, membershipB.id);
  });

  it('list e count de cada empresa enxergam só os seus', async () => {
    const listedA = await memberships.list(companyA.id);
    assert.deepEqual(
      listedA.items.map((membership) => membership.id),
      [membershipA.id],
    );
    assert.equal(await memberships.count(companyA.id), 1);
    assert.equal(await memberships.count(companyB.id), 1);
    const empty = await tenants.createCompany('usr-vazio');
    assert.equal(await memberships.count(empty.id), 0);
  });

  it('update e delete com o CompanyId de A não tocam o usuário de B (NotFoundError)', async () => {
    await assert.rejects(
      memberships.update(companyA.id, membershipB.id, { role: 'AGENT' }),
      NotFoundError,
    );
    await assert.rejects(memberships.delete(companyA.id, membershipB.id), NotFoundError);
    await assert.rejects(
      memberships.updatePassword(companyA.id, membershipB.id, HASH_A),
      NotFoundError,
    );
    const still = await memberships.findById(companyB.id, membershipB.id);
    assert.equal(still.role, 'OWNER');
    const creds = await memberships.findCredentialsByEmail(companyB.id, sharedEmail);
    assert.equal(creds?.passwordHash, HASH_B);
  });

  it('o dono atualiza papel e status; updatePassword troca só o hash', async () => {
    const created = await memberships.create(companyA.id, {
      email: email('upd'),
      passwordHash: HASH_A,
    });
    const updated = await memberships.update(companyA.id, created.id, {
      role: 'OWNER',
      status: 'DISABLED',
    });
    assert.equal(updated.role, 'OWNER');
    assert.equal(updated.status, 'DISABLED');
    await memberships.updatePassword(companyA.id, created.id, HASH_B);
    assert.equal(
      (await memberships.findCredentialsByEmail(companyA.id, created.email))?.passwordHash,
      HASH_B,
    );
    await memberships.delete(companyA.id, created.id);
    await assert.rejects(memberships.findById(companyA.id, created.id), NotFoundError);
  });

  it('findCredentialsByEmail(A, emailDeB) devolve null; o mesmo e-mail em cada empresa é o da empresa', async () => {
    const onlyB = email('so-b');
    await memberships.create(companyB.id, { email: onlyB, passwordHash: HASH_B });
    assert.equal(await memberships.findCredentialsByEmail(companyA.id, onlyB), null);
    assert.equal(
      (await memberships.findCredentialsByEmail(companyB.id, onlyB))?.membership.companyId,
      companyB.id,
    );
    // O mesmo e-mail existe nas duas empresas, cada busca devolve o usuário da própria empresa.
    assert.equal(
      (await memberships.findCredentialsByEmail(companyA.id, sharedEmail))?.membership.id,
      membershipA.id,
    );
    assert.equal(
      (await memberships.findCredentialsByEmail(companyB.id, sharedEmail))?.membership.id,
      membershipB.id,
    );
  });

  it('o mesmo e-mail em duas empresas não conflita; repetir no mesma empresa é ConflictError', async () => {
    await assert.rejects(
      memberships.create(companyA.id, { email: sharedEmail, passwordHash: HASH_A }),
      ConflictError,
    );
    await assert.rejects(
      memberships.create(companyB.id, { email: sharedEmail, passwordHash: HASH_B }),
      ConflictError,
    );
  });

  it('create grava na empresa do parâmetro mesmo com outro companyId injetado em runtime', async () => {
    const hostile = {
      email: email('hostil'),
      passwordHash: HASH_A,
      companyId: companyB.id,
    } as unknown as NewMembership;
    const created = await memberships.create(companyA.id, hostile);
    assert.equal(created.companyId, companyA.id);
    await assert.rejects(memberships.findById(companyB.id, created.id), NotFoundError);
  });

  it('o hash da senha nunca aparece na entidade devolvida', async () => {
    const created = await memberships.create(companyA.id, {
      email: email('hash'),
      passwordHash: HASH_A,
    });
    for (const entity of [
      created,
      await memberships.findById(companyA.id, created.id),
      ...(await memberships.list(companyA.id)).items,
    ]) {
      assert.ok(!('passwordHash' in entity));
      assert.ok(!JSON.stringify(entity).includes(HASH_A));
    }
  });

  it('consulta de Membership sem companyId lança TenantScopeError (segunda barreira)', async () => {
    const prisma = database.prisma;
    const attempts: readonly (() => Promise<unknown>)[] = [
      () => prisma.membership.findMany({}),
      () => prisma.membership.findFirst({ where: { email: sharedEmail } }),
      () => prisma.membership.count({}),
      () => prisma.membership.deleteMany({}),
      () =>
        prisma.membership.updateMany({ where: { email: sharedEmail }, data: { role: 'OWNER' } }),
      () => prisma.membership.findUnique({ where: { id: membershipA.id } }),
      () =>
        prisma.membership.create({
          data: { email: 'x@y.test', passwordHash: 'h', company: { connect: { id: companyA.id } } },
        }),
    ];
    for (const attempt of attempts) {
      await assert.rejects(attempt, TenantScopeError);
    }
  });

  it('CompanyId inexistente: nada é encontrado', async () => {
    const ghost = CompanyId.parse('01900000-0000-7000-8000-000000000000');
    assert.equal(await memberships.findCredentialsByEmail(ghost, sharedEmail), null);
    assert.equal(await memberships.count(ghost), 0);
  });
});

describe('PlatformAdmin (model global)', () => {
  it('cria, busca por e-mail e por id, troca a senha; e-mail repetido é ConflictError', async () => {
    const admins = new PrismaPlatformAdminRepository(database.prisma);
    const address = email('plataforma');
    const created = await admins.create({ email: address, passwordHash: HASH_A });
    try {
      assert.ok(!('passwordHash' in created));
      assert.equal((await admins.findById(created.id)).email, address);
      assert.equal((await admins.findCredentialsByEmail(address))?.passwordHash, HASH_A);
      assert.equal(await admins.findCredentialsByEmail(email('outro')), null);
      await admins.updatePassword(created.id, HASH_B);
      assert.equal((await admins.findCredentialsByEmail(address))?.passwordHash, HASH_B);
      await assert.rejects(admins.create({ email: address, passwordHash: HASH_A }), ConflictError);
    } finally {
      await database.prisma.platformAdmin.deleteMany({ where: { id: created.id } });
    }
    await assert.rejects(admins.findById(created.id), NotFoundError);
    await assert.rejects(admins.updatePassword(created.id, HASH_A), NotFoundError);
  });
});

describe('MembershipRepository: papéis novos e métodos da spec 008', () => {
  it('aceita os quatro papéis e atualiza entre eles', async () => {
    for (const role of ['OWNER', 'ADMIN', 'AGENT', 'VIEWER'] as const) {
      const created = await memberships.create(companyA.id, {
        email: email(`papel-${role.toLowerCase()}`),
        passwordHash: HASH_A,
        role,
      });
      assert.equal(created.role, role);
    }
    const target = await memberships.create(companyA.id, {
      email: email('troca'),
      passwordHash: HASH_A,
    });
    assert.equal(
      (await memberships.update(companyA.id, target.id, { role: 'VIEWER' })).role,
      'VIEWER',
    );
    assert.equal(
      (await memberships.update(companyA.id, target.id, { role: 'ADMIN' })).role,
      'ADMIN',
    );
  });

  it('findCredentialsById: da própria empresa devolve o hash; de outra empresa ou id inválido, NotFoundError', async () => {
    const found = await memberships.findCredentialsById(companyB.id, membershipB.id);
    assert.equal(found.passwordHash, HASH_B);
    assert.equal(found.membership.id, membershipB.id);
    assert.ok(!('passwordHash' in found.membership));
    await assert.rejects(
      memberships.findCredentialsById(companyA.id, membershipB.id),
      NotFoundError,
    );
    await assert.rejects(memberships.findCredentialsById(companyB.id, 'nao-e-uuid'), NotFoundError);
  });

  it('countActiveOwners conta só OWNER ativa da própria empresa', async () => {
    const fresh = await tenants.createCompany('usr-own');
    assert.equal(await memberships.countActiveOwners(fresh.id), 0);
    const first = await memberships.create(fresh.id, {
      email: email('o1'),
      passwordHash: HASH_A,
      role: 'OWNER',
    });
    await memberships.create(fresh.id, { email: email('o2'), passwordHash: HASH_A, role: 'OWNER' });
    await memberships.create(fresh.id, {
      email: email('adm'),
      passwordHash: HASH_A,
      role: 'ADMIN',
    });
    assert.equal(await memberships.countActiveOwners(fresh.id), 2);
    await memberships.update(fresh.id, first.id, { status: 'DISABLED' });
    assert.equal(await memberships.countActiveOwners(fresh.id), 1);
    // Os OWNER de outras empresas não entram na conta.
    assert.equal(await memberships.countActiveOwners(companyB.id), 1);
    assert.equal(
      await memberships.countActiveOwners(CompanyId.parse('01900000-0000-7000-8000-000000000000')),
      0,
    );
  });
});
