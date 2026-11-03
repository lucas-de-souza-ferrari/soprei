import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { type Client, ClientId, type NewUser, type User } from '../../../domain/index.js';
import { ConflictError, NotFoundError, TenantScopeError } from '../../../shared/errors/index.js';
import { loadIntegrationConfig } from '../../../test-support/integration-env.js';
import { TestTenants } from '../../../test-support/tenant-fixtures.js';
import { createLogger } from '../../logger/logger.js';
import { createDatabase, type Database } from '../database.js';
import { PrismaPlatformAdminRepository } from './platform-admin.repository.js';
import { PrismaUserRepository } from './user.repository.js';

const config = loadIntegrationConfig();
const HASH_A = 'scrypt$1024$8$1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA==';
const HASH_B = 'scrypt$1024$8$1$b3V0cm9zYWx0b3V0cm8=$b3V0cm9oYXNoYm91dHJvaGFzaGJvdXRybw==';

let database: Database;
let tenants: TestTenants;
let users: PrismaUserRepository;
let clientA: Client;
let clientB: Client;
let userA: User;
let userB: User;
const email = (label: string): string => `${label}-${randomBytes(5).toString('hex')}@exemplo.test`;
const sharedEmail = email('mesmo');

before(async () => {
  database = createDatabase(config, createLogger(config));
  tenants = new TestTenants(database.prisma);
  users = new PrismaUserRepository(database.prisma);
  clientA = await tenants.createClient('usr-a');
  clientB = await tenants.createClient('usr-b');
  userA = await users.create(clientA.id, { email: sharedEmail, passwordHash: HASH_A });
  userB = await users.create(clientB.id, {
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

describe('isolamento no repositório de User (clientes A e B)', () => {
  it('o cliente A não encontra o usuário de B: findById é NotFoundError, com o ClientId de B funciona', async () => {
    await assert.rejects(users.findById(clientA.id, userB.id), NotFoundError);
    assert.equal((await users.findById(clientB.id, userB.id)).id, userB.id);
  });

  it('list e count de cada cliente enxergam só os seus', async () => {
    const listedA = await users.list(clientA.id);
    assert.deepEqual(
      listedA.items.map((user) => user.id),
      [userA.id],
    );
    assert.equal(await users.count(clientA.id), 1);
    assert.equal(await users.count(clientB.id), 1);
    const empty = await tenants.createClient('usr-vazio');
    assert.equal(await users.count(empty.id), 0);
  });

  it('update e delete com o ClientId de A não tocam o usuário de B (NotFoundError)', async () => {
    await assert.rejects(users.update(clientA.id, userB.id, { role: 'AGENT' }), NotFoundError);
    await assert.rejects(users.delete(clientA.id, userB.id), NotFoundError);
    await assert.rejects(users.updatePassword(clientA.id, userB.id, HASH_A), NotFoundError);
    const still = await users.findById(clientB.id, userB.id);
    assert.equal(still.role, 'OWNER');
    const creds = await users.findCredentialsByEmail(clientB.id, sharedEmail);
    assert.equal(creds?.passwordHash, HASH_B);
  });

  it('o dono atualiza papel e status; updatePassword troca só o hash', async () => {
    const created = await users.create(clientA.id, { email: email('upd'), passwordHash: HASH_A });
    const updated = await users.update(clientA.id, created.id, {
      role: 'OWNER',
      status: 'DISABLED',
    });
    assert.equal(updated.role, 'OWNER');
    assert.equal(updated.status, 'DISABLED');
    await users.updatePassword(clientA.id, created.id, HASH_B);
    assert.equal(
      (await users.findCredentialsByEmail(clientA.id, created.email))?.passwordHash,
      HASH_B,
    );
    await users.delete(clientA.id, created.id);
    await assert.rejects(users.findById(clientA.id, created.id), NotFoundError);
  });

  it('findCredentialsByEmail(A, emailDeB) devolve null; o mesmo e-mail em cada cliente é o do cliente', async () => {
    const onlyB = email('so-b');
    await users.create(clientB.id, { email: onlyB, passwordHash: HASH_B });
    assert.equal(await users.findCredentialsByEmail(clientA.id, onlyB), null);
    assert.equal(
      (await users.findCredentialsByEmail(clientB.id, onlyB))?.user.clientId,
      clientB.id,
    );
    // O mesmo e-mail existe nos dois clientes, cada busca devolve o usuário do próprio cliente.
    assert.equal((await users.findCredentialsByEmail(clientA.id, sharedEmail))?.user.id, userA.id);
    assert.equal((await users.findCredentialsByEmail(clientB.id, sharedEmail))?.user.id, userB.id);
  });

  it('o mesmo e-mail em dois clientes não conflita; repetir no mesmo cliente é ConflictError', async () => {
    await assert.rejects(
      users.create(clientA.id, { email: sharedEmail, passwordHash: HASH_A }),
      ConflictError,
    );
    await assert.rejects(
      users.create(clientB.id, { email: sharedEmail, passwordHash: HASH_B }),
      ConflictError,
    );
  });

  it('create grava no cliente do parâmetro mesmo com outro clientId injetado em runtime', async () => {
    const hostile = {
      email: email('hostil'),
      passwordHash: HASH_A,
      clientId: clientB.id,
    } as unknown as NewUser;
    const created = await users.create(clientA.id, hostile);
    assert.equal(created.clientId, clientA.id);
    await assert.rejects(users.findById(clientB.id, created.id), NotFoundError);
  });

  it('o hash da senha nunca aparece na entidade devolvida', async () => {
    const created = await users.create(clientA.id, { email: email('hash'), passwordHash: HASH_A });
    for (const entity of [
      created,
      await users.findById(clientA.id, created.id),
      ...(await users.list(clientA.id)).items,
    ]) {
      assert.ok(!('passwordHash' in entity));
      assert.ok(!JSON.stringify(entity).includes(HASH_A));
    }
  });

  it('consulta de User sem clientId lança TenantScopeError (segunda barreira)', async () => {
    const prisma = database.prisma;
    const attempts: readonly (() => Promise<unknown>)[] = [
      () => prisma.user.findMany({}),
      () => prisma.user.findFirst({ where: { email: sharedEmail } }),
      () => prisma.user.count({}),
      () => prisma.user.deleteMany({}),
      () => prisma.user.updateMany({ where: { email: sharedEmail }, data: { role: 'OWNER' } }),
      () => prisma.user.findUnique({ where: { id: userA.id } }),
      () =>
        prisma.user.create({
          data: { email: 'x@y.test', passwordHash: 'h', client: { connect: { id: clientA.id } } },
        }),
    ];
    for (const attempt of attempts) {
      await assert.rejects(attempt, TenantScopeError);
    }
  });

  it('ClientId inexistente: nada é encontrado', async () => {
    const ghost = ClientId.parse('01900000-0000-7000-8000-000000000000');
    assert.equal(await users.findCredentialsByEmail(ghost, sharedEmail), null);
    assert.equal(await users.count(ghost), 0);
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

describe('UserRepository: papéis novos e métodos da spec 008', () => {
  it('aceita os quatro papéis e atualiza entre eles', async () => {
    for (const role of ['OWNER', 'ADMIN', 'AGENT', 'VIEWER'] as const) {
      const created = await users.create(clientA.id, {
        email: email(`papel-${role.toLowerCase()}`),
        passwordHash: HASH_A,
        role,
      });
      assert.equal(created.role, role);
    }
    const target = await users.create(clientA.id, { email: email('troca'), passwordHash: HASH_A });
    assert.equal((await users.update(clientA.id, target.id, { role: 'VIEWER' })).role, 'VIEWER');
    assert.equal((await users.update(clientA.id, target.id, { role: 'ADMIN' })).role, 'ADMIN');
  });

  it('findCredentialsById: do próprio cliente devolve o hash; de outro cliente ou id inválido, NotFoundError', async () => {
    const found = await users.findCredentialsById(clientB.id, userB.id);
    assert.equal(found.passwordHash, HASH_B);
    assert.equal(found.user.id, userB.id);
    assert.ok(!('passwordHash' in found.user));
    await assert.rejects(users.findCredentialsById(clientA.id, userB.id), NotFoundError);
    await assert.rejects(users.findCredentialsById(clientB.id, 'nao-e-uuid'), NotFoundError);
  });

  it('countActiveOwners conta só OWNER ativo do próprio cliente', async () => {
    const fresh = await tenants.createClient('usr-own');
    assert.equal(await users.countActiveOwners(fresh.id), 0);
    const first = await users.create(fresh.id, {
      email: email('o1'),
      passwordHash: HASH_A,
      role: 'OWNER',
    });
    await users.create(fresh.id, { email: email('o2'), passwordHash: HASH_A, role: 'OWNER' });
    await users.create(fresh.id, { email: email('adm'), passwordHash: HASH_A, role: 'ADMIN' });
    assert.equal(await users.countActiveOwners(fresh.id), 2);
    await users.update(fresh.id, first.id, { status: 'DISABLED' });
    assert.equal(await users.countActiveOwners(fresh.id), 1);
    // Os OWNER de outros clientes não entram na conta.
    assert.equal(await users.countActiveOwners(clientB.id), 1);
    assert.equal(
      await users.countActiveOwners(ClientId.parse('01900000-0000-7000-8000-000000000000')),
      0,
    );
  });
});
