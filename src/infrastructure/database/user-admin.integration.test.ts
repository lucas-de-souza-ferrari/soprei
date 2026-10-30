import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { deriveLoginLockSecret } from '../../application/auth/auth.service.js';
import type { UserIdentity } from '../../application/auth/identity.js';
import { UserAdminService } from '../../application/users/user-admin.service.js';
import { type Client, ClientId, type User, type UserRole } from '../../domain/index.js';
import {
  ConflictError,
  DatabaseError,
  ForbiddenError,
  NotFoundError,
} from '../../shared/errors/index.js';
import { FakePasswordHasher, InMemorySessionStore } from '../../test-support/in-memory-auth.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import { createLogger } from '../logger/logger.js';
import { createDatabase, type Database } from './database.js';
import { PrismaAuditRepository } from './repositories/audit.repository.js';
import { PrismaUserAdminUnitOfWork } from './repositories/user-admin-unit-of-work.js';
import { PrismaUserRepository } from './repositories/user.repository.js';

const config = loadIntegrationConfig();
const HASH = 'fake$hash-de-teste';

let database: Database;
let tenants: TestTenants;
let users: PrismaUserRepository;
let audit: PrismaAuditRepository;
let unitOfWork: PrismaUserAdminUnitOfWork;
let service: UserAdminService;
let sessions: InMemorySessionStore;

const email = (label: string): string => `${label}-${randomBytes(5).toString('hex')}@exemplo.test`;
const identity = (user: User): UserIdentity => ({
  kind: 'user',
  userId: user.id,
  clientId: user.clientId,
  role: user.role,
  sessionId: 'sessao-de-teste',
});
const seed = (client: Client, role: UserRole): Promise<User> =>
  users.create(client.id, { email: email(role.toLowerCase()), passwordHash: HASH, role });

/** Espera até `condition` (sondagem com prazo, nunca sleep fixo como asserção de espera). */
async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('prazo esgotado esperando a condição');
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

before(() => {
  database = createDatabase(config, createLogger(config));
  tenants = new TestTenants(database.prisma);
  users = new PrismaUserRepository(database.prisma);
  audit = new PrismaAuditRepository(database.prisma);
  unitOfWork = new PrismaUserAdminUnitOfWork(database.prisma);
  sessions = new InMemorySessionStore();
  service = new UserAdminService({
    users,
    audit,
    unitOfWork,
    hasher: new FakePasswordHasher(),
    sessions,
    logger: captureLogs().logger,
    loginLockSecret: deriveLoginLockSecret('segredo-de-teste-com-mais-de-32-caracteres'),
  });
});

after(async () => {
  try {
    await tenants.cleanup();
  } finally {
    await database.close();
  }
});

describe('UserAdminUnitOfWork (Postgres real)', () => {
  it('lockClient serializa: a segunda transação só entra depois do commit da primeira', async () => {
    const client = await tenants.createClient('uow-lock');
    const events: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = unitOfWork.run(async (tx) => {
      await tx.lockClient(client.id);
      events.push('A:travou');
      await gate;
      events.push('A:vai-confirmar');
    });
    await until(() => events.includes('A:travou'));
    const second = unitOfWork.run(async (tx) => {
      await tx.lockClient(client.id);
      events.push('B:travou');
    });
    // Margem folgada: se o bloqueio não existisse, B travaria em milissegundos. Uma espera longa
    // demais só atrasa o teste; nunca o faz falhar à toa.
    await new Promise((resolve) => {
      setTimeout(resolve, 400);
    });
    assert.ok(!events.includes('B:travou'), 'B esperou pelo bloqueio de A');
    release?.();
    await Promise.all([first, second]);
    assert.deepEqual(events, ['A:travou', 'A:vai-confirmar', 'B:travou']);
  });

  it('clientes diferentes não se bloqueiam entre si', async () => {
    const a = await tenants.createClient('uow-lock-a');
    const b = await tenants.createClient('uow-lock-b');
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const first = unitOfWork.run(async (tx) => {
      await tx.lockClient(a.id);
      held = true;
      await gate;
    });
    await until(() => held);
    await unitOfWork.run((tx) => tx.lockClient(b.id));
    release?.();
    await first;
  });

  it('o bloqueio não impede gravar conversa do mesmo cliente (FOR NO KEY UPDATE não toma o KEY SHARE das FKs)', async () => {
    const client = await tenants.createClient('uow-keyshare');
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const holder = unitOfWork.run(async (tx) => {
      await tx.lockClient(client.id);
      held = true;
      await gate;
    });
    await until(() => held);
    try {
      const created = await Promise.race([
        database.prisma.conversation
          .create({ data: { clientId: client.id, contactRef: 'contato-livre' } })
          .then(() => 'gravou'),
        new Promise<string>((resolve) => {
          setTimeout(() => {
            resolve('bloqueou');
          }, 3_000);
        }),
      ]);
      assert.equal(created, 'gravou');
    } finally {
      release?.();
      await holder;
    }
  });

  it('lockClient de cliente inexistente é NotFoundError', async () => {
    await assert.rejects(
      unitOfWork.run((tx) => tx.lockClient(ClientId.parse('01900000-0000-7000-8000-000000000000'))),
      NotFoundError,
    );
  });

  it('atomicidade: falha da trilha desfaz a mudança do usuário, e falha do usuário desfaz a trilha', async () => {
    const client = await tenants.createClient('uow-atomic');
    const other = await tenants.createClient('uow-atomic-b');
    const owner = await seed(client, 'OWNER');
    const target = await seed(client, 'AGENT');
    const foreign = await seed(other, 'OWNER');

    // Trilha falha (ator de outro cliente: viola a FK composta) depois de mudar o usuário.
    await assert.rejects(
      unitOfWork.run(async (tx) => {
        await tx.users.update(client.id, target.id, { role: 'VIEWER' });
        await tx.audit.create(client.id, {
          action: 'USER_ROLE_CHANGED',
          actorUserId: foreign.id,
          targetUserId: target.id,
          fromRole: 'AGENT',
          toRole: 'VIEWER',
        });
      }),
      DatabaseError,
    );
    assert.equal((await users.findById(client.id, target.id)).role, 'AGENT');
    assert.equal((await audit.list(client.id)).items.length, 0);

    // Usuário falha (e-mail repetido) depois de gravar a trilha.
    await assert.rejects(
      unitOfWork.run(async (tx) => {
        await tx.audit.create(client.id, {
          action: 'USER_DISABLED',
          actorUserId: owner.id,
          targetUserId: target.id,
        });
        await tx.users.create(client.id, { email: target.email, passwordHash: HASH });
      }),
      ConflictError,
    );
    assert.equal((await audit.list(client.id)).items.length, 0);
  });
});

describe('UserAdminService com Postgres real', () => {
  it('dois OWNER se rebaixando SIMULTANEAMENTE: exatamente um pedido tem sucesso e sobra um OWNER ativo (repetido várias vezes)', async () => {
    for (let round = 0; round < 12; round += 1) {
      const client = await tenants.createClient(`race-${String(round)}`);
      const first = await seed(client, 'OWNER');
      const second = await seed(client, 'OWNER');
      const results = await Promise.allSettled([
        service.updateUser(identity(first), second.id, { role: 'ADMIN' }),
        service.updateUser(identity(second), first.id, { role: 'ADMIN' }),
      ]);
      const ok = results.filter((result) => result.status === 'fulfilled');
      const failed = results.filter((result) => result.status === 'rejected');
      assert.equal(ok.length, 1, `rodada ${String(round)}: exatamente um sucesso`);
      assert.equal(failed.length, 1);
      // O perdedor é barrado no próprio papel (relido do banco depois do bloqueio) ou pela regra do
      // último OWNER; nunca passa.
      const reason = (failed[0] as PromiseRejectedResult).reason as unknown;
      assert.ok(reason instanceof ForbiddenError || reason instanceof ConflictError);
      assert.equal(await users.countActiveOwners(client.id), 1, `rodada ${String(round)}`);
      assert.equal((await audit.list(client.id)).items.length, 1);
    }
  });

  it('dois OWNER se desativando simultaneamente: um OWNER ativo sobra', async () => {
    for (let round = 0; round < 6; round += 1) {
      const client = await tenants.createClient(`race-d-${String(round)}`);
      const first = await seed(client, 'OWNER');
      const second = await seed(client, 'OWNER');
      const results = await Promise.allSettled([
        service.updateUser(identity(first), second.id, { status: 'DISABLED' }),
        service.updateUser(identity(second), first.id, { status: 'DISABLED' }),
      ]);
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(await users.countActiveOwners(client.id), 1);
    }
  });

  it('promover e desativar o mesmo usuário ao mesmo tempo: serializados, resultado consistente e a regra vale', async () => {
    const client = await tenants.createClient('race-mix');
    const owner = await seed(client, 'OWNER');
    const owner2 = await seed(client, 'OWNER');
    const agent = await seed(client, 'AGENT');
    const results = await Promise.allSettled([
      service.updateUser(identity(owner), agent.id, { role: 'OWNER' }),
      service.updateUser(identity(owner2), agent.id, { status: 'DISABLED' }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 2);
    const final = await users.findById(client.id, agent.id);
    assert.equal(final.status, 'DISABLED');
    assert.equal(final.role, 'OWNER');
    assert.equal(await users.countActiveOwners(client.id), 2);
  });

  it('o fluxo completo grava a trilha com ator, alvo, ação e papéis, e o isolamento vale no banco', async () => {
    const client = await tenants.createClient('flow-a');
    const other = await tenants.createClient('flow-b');
    const owner = await seed(client, 'OWNER');
    const alien = await seed(other, 'AGENT');
    const created = await service.createUser(identity(owner), {
      email: email('novo'),
      password: 'uma-senha-forte-de-teste-1',
      role: 'AGENT',
    });
    await service.updateUser(identity(owner), created.id, { role: 'ADMIN' });
    await service.updateUser(identity(owner), created.id, { status: 'DISABLED' });
    await service.resetPassword(identity(owner), created.id, 'outra-senha-forte-de-teste-2');
    const events = (await audit.list(client.id)).items;
    assert.deepEqual(events.map((event) => event.action).reverse(), [
      'USER_CREATED',
      'USER_ROLE_CHANGED',
      'USER_DISABLED',
      'USER_PASSWORD_RESET',
    ]);
    assert.ok(
      events.every((event) => event.clientId === client.id && event.actorUserId === owner.id),
    );
    assert.equal((await audit.list(other.id)).items.length, 0);
    await assert.rejects(
      service.updateUser(identity(owner), alien.id, { role: 'VIEWER' }),
      NotFoundError,
    );
    assert.equal((await users.findById(other.id, alien.id)).role, 'AGENT');
    // A senha só é gravada como hash (o fake devolve um prefixo reconhecível).
    const credentials = await users.findCredentialsById(client.id, created.id);
    assert.match(credentials.passwordHash, /^fake\$/);
  });
});
