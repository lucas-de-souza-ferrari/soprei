import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  canManageRole,
  type Client,
  type User,
  USER_ROLES,
  type UserRepository,
  type UserRole,
} from '../../domain/index.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../shared/errors/index.js';
import { buildTestAuth, type TestAuth } from '../../test-support/in-memory-auth.js';
import { captureLogs, type LogCapture } from '../../test-support/log-capture.js';
import type { UserIdentity } from '../auth/identity.js';
import type { UserAdminTransaction } from '../ports/user-admin-unit-of-work.js';
import { LAST_OWNER_CODE, UserAdminService } from './user-admin.service.js';

const PASSWORD = 'uma-senha-forte-de-teste-1';

interface Env {
  auth: TestAuth;
  logs: LogCapture;
  client: Client;
  other: Client;
}

async function setup(): Promise<Env> {
  const logs = captureLogs();
  const auth = buildTestAuth({ logger: logs.logger });
  const client = await auth.clients.create({ name: 'A', slug: 'cliente-a' });
  const other = await auth.clients.create({ name: 'B', slug: 'cliente-b' });
  return { auth, logs, client, other };
}

async function seed(env: Env, role: UserRole, client: Client = env.client): Promise<User> {
  return env.auth.users.create(client.id, {
    email: `${role.toLowerCase()}-${Math.random().toString(36).slice(2)}@exemplo.test`,
    passwordHash: await env.auth.hasher.hash(PASSWORD),
    role,
  });
}

function identity(user: User, roleClaim: UserRole = user.role): UserIdentity {
  return {
    kind: 'user',
    userId: user.id,
    clientId: user.clientId,
    role: roleClaim,
    sessionId: 'sessao-de-teste',
  };
}

describe('UserAdminService: hierarquia reaplicada no service (matriz completa)', () => {
  let env: Env;
  beforeEach(async () => {
    env = await setup();
  });

  it('mudar papel: ator x papel atual do alvo x papel novo, exatamente como canManageRole', async () => {
    for (const actorRole of USER_ROLES) {
      for (const targetRole of USER_ROLES) {
        for (const newRole of USER_ROLES) {
          if (newRole === targetRole) continue;
          const actor = await seed(env, actorRole);
          // Um OWNER de reserva garante que a regra do último OWNER nunca é o motivo da recusa.
          await seed(env, 'OWNER');
          const target = await seed(env, targetRole);
          const allowed =
            (actorRole === 'OWNER' || actorRole === 'ADMIN') &&
            canManageRole(actorRole, targetRole) &&
            canManageRole(actorRole, newRole);
          const run = env.auth.userAdmin.updateUser(identity(actor), target.id, { role: newRole });
          if (allowed) {
            assert.equal((await run).role, newRole, `${actorRole} ${targetRole}->${newRole}`);
          } else {
            await assert.rejects(run, ForbiddenError, `${actorRole} ${targetRole}->${newRole}`);
            assert.equal(
              (await env.auth.users.findById(env.client.id, target.id)).role,
              targetRole,
            );
          }
        }
      }
    }
  });

  it('desativar e redefinir senha: só quem gerencia o papel atual do alvo', async () => {
    for (const actorRole of USER_ROLES) {
      for (const targetRole of USER_ROLES) {
        const actor = await seed(env, actorRole);
        await seed(env, 'OWNER');
        const target = await seed(env, targetRole);
        const allowed = canManageRole(actorRole, targetRole);
        for (const run of [
          () => env.auth.userAdmin.updateUser(identity(actor), target.id, { status: 'DISABLED' }),
          () => env.auth.userAdmin.resetPassword(identity(actor), target.id, PASSWORD),
        ]) {
          if (allowed) await run();
          else await assert.rejects(run(), ForbiddenError, `${actorRole} -> ${targetRole}`);
        }
      }
    }
  });

  it('criar: só atribui papel que o ator gerencia; AGENT e VIEWER nunca criam', async () => {
    for (const actorRole of USER_ROLES) {
      for (const role of USER_ROLES) {
        const actor = await seed(env, actorRole);
        const run = () =>
          env.auth.userAdmin.createUser(identity(actor), {
            email: `n-${Math.random().toString(36).slice(2)}@exemplo.test`,
            password: PASSWORD,
            role,
          });
        if (canManageRole(actorRole, role)) assert.equal((await run()).role, role);
        else await assert.rejects(run(), ForbiddenError, `${actorRole} cria ${role}`);
      }
    }
  });

  it('o papel do TOKEN não vale: o do banco manda (token adulterado ou desatualizado não escala)', async () => {
    const owner = await seed(env, 'OWNER');
    const admin = await seed(env, 'ADMIN');
    const agent = await seed(env, 'AGENT');
    // Token que diz OWNER, banco que diz AGENT.
    const stale = identity(agent, 'OWNER');
    await assert.rejects(
      env.auth.userAdmin.updateUser(stale, admin.id, { role: 'VIEWER' }),
      ForbiddenError,
    );
    await assert.rejects(
      env.auth.userAdmin.createUser(stale, {
        email: 'x@exemplo.test',
        password: PASSWORD,
        role: 'OWNER',
      }),
      ForbiddenError,
    );
    // Token que diz AGENT não permite nem chegar ao banco.
    await assert.rejects(
      env.auth.userAdmin.updateUser(identity(owner, 'AGENT'), agent.id, { role: 'VIEWER' }),
      ForbiddenError,
    );
    assert.equal((await env.auth.users.findById(env.client.id, admin.id)).role, 'ADMIN');
    assert.equal((await env.auth.users.findById(env.client.id, agent.id)).role, 'AGENT');
  });

  it('ator desativado ou removido não age com token ainda válido', async () => {
    const owner = await seed(env, 'OWNER');
    const target = await seed(env, 'AGENT');
    await env.auth.users.update(env.client.id, owner.id, { status: 'DISABLED' });
    await assert.rejects(
      env.auth.userAdmin.updateUser(identity(owner), target.id, { role: 'VIEWER' }),
      ForbiddenError,
    );
    await env.auth.users.delete(env.client.id, owner.id);
    await assert.rejects(
      env.auth.userAdmin.resetPassword(identity(owner), target.id, PASSWORD),
      ForbiddenError,
    );
  });

  it('o ClientId é o do ator: usuário de outro cliente é NotFoundError e nada muda', async () => {
    const owner = await seed(env, 'OWNER');
    const alien = await seed(env, 'AGENT', env.other);
    await assert.rejects(
      env.auth.userAdmin.updateUser(identity(owner), alien.id, { role: 'VIEWER' }),
      NotFoundError,
    );
    await assert.rejects(
      env.auth.userAdmin.resetPassword(identity(owner), alien.id, PASSWORD),
      NotFoundError,
    );
    assert.equal((await env.auth.users.findById(env.other.id, alien.id)).role, 'AGENT');
    assert.equal(env.auth.audit.events.length, 0);
    const page = await env.auth.userAdmin.listUsers(identity(owner));
    assert.ok(page.items.every((user) => user.id !== alien.id));
  });
});

describe('UserAdminService: bloqueio do cliente e regra do último OWNER', () => {
  let env: Env;
  beforeEach(async () => {
    env = await setup();
  });

  /** Serviço cujo `countActiveOwners` devolve o número informado e registra a ordem das chamadas. */
  function withOwnerCount(count: number): { service: UserAdminService; calls: string[] } {
    const calls: string[] = [];
    const wrap = (tx: UserAdminTransaction): UserAdminTransaction => {
      const users: UserRepository = Object.create(tx.users) as UserRepository;
      return {
        audit: tx.audit,
        users: Object.assign(users, {
          findById: (...args: Parameters<UserRepository['findById']>) => {
            calls.push('findById');
            return tx.users.findById(...args);
          },
          countActiveOwners: () => {
            calls.push('countActiveOwners');
            return Promise.resolve(count);
          },
        }),
        lockClient: async (clientId) => {
          calls.push('lock');
          await tx.lockClient(clientId);
        },
      };
    };
    const service = new UserAdminService({
      users: env.auth.users,
      audit: env.auth.audit,
      unitOfWork: { run: (fn) => env.auth.unitOfWork.run((tx) => fn(wrap(tx))) },
      hasher: env.auth.hasher,
      sessions: env.auth.sessions,
      logger: env.logs.logger,
      loginLockSecret: 'segredo-de-teste',
    });
    return { service, calls };
  }

  it('rebaixar ou desativar o último OWNER ativo é ConflictError LAST_OWNER, nada muda e nada é gravado', async () => {
    const actor = await seed(env, 'OWNER');
    const target = await seed(env, 'OWNER');
    const { service } = withOwnerCount(1);
    for (const patch of [{ role: 'AGENT' as const }, { status: 'DISABLED' as const }]) {
      await assert.rejects(
        service.updateUser(identity(actor), target.id, patch),
        (error: unknown) =>
          error instanceof ConflictError &&
          error.code === LAST_OWNER_CODE &&
          error.statusCode === 409,
      );
    }
    assert.equal((await env.auth.users.findById(env.client.id, target.id)).role, 'OWNER');
    assert.equal((await env.auth.users.findById(env.client.id, target.id)).status, 'ACTIVE');
    assert.equal(env.auth.audit.events.length, 0);
  });

  it('com mais de um OWNER ativo a mesma operação passa', async () => {
    const actor = await seed(env, 'OWNER');
    const target = await seed(env, 'OWNER');
    const { service } = withOwnerCount(2);
    assert.equal(
      (await service.updateUser(identity(actor), target.id, { role: 'AGENT' })).role,
      'AGENT',
    );
  });

  it('a regra não bloqueia o que não tira um OWNER ativo (reativar, promover, mudar AGENT)', async () => {
    const actor = await seed(env, 'OWNER');
    const agent = await seed(env, 'AGENT');
    const { service } = withOwnerCount(1);
    assert.equal(
      (await service.updateUser(identity(actor), agent.id, { role: 'ADMIN' })).role,
      'ADMIN',
    );
    assert.equal(
      (await service.updateUser(identity(actor), agent.id, { role: 'OWNER' })).role,
      'OWNER',
    );
  });

  it('toda escrita trava o cliente ANTES de ler o ator, e a contagem de OWNER vem depois do bloqueio', async () => {
    const actor = await seed(env, 'OWNER');
    const target = await seed(env, 'OWNER');
    const { service, calls } = withOwnerCount(5);
    await service.updateUser(identity(actor), target.id, { role: 'AGENT' });
    assert.equal(calls[0], 'lock');
    assert.ok(calls.indexOf('countActiveOwners') > calls.indexOf('lock'));

    const before = env.auth.unitOfWork.lockCalls;
    await service.createUser(identity(actor), {
      email: 'n@exemplo.test',
      password: PASSWORD,
      role: 'AGENT',
    });
    await service.resetPassword(identity(actor), target.id, PASSWORD);
    assert.equal(
      env.auth.unitOfWork.lockCalls,
      before + 2,
      'criar e redefinir também travam o cliente',
    );
  });

  it('operações simultâneas do mesmo cliente são serializadas (a unidade de trabalho em memória faz o papel do bloqueio)', async () => {
    const first = await seed(env, 'OWNER');
    const second = await seed(env, 'OWNER');
    const results = await Promise.allSettled([
      env.auth.userAdmin.updateUser(identity(first), second.id, { role: 'ADMIN' }),
      env.auth.userAdmin.updateUser(identity(second), first.id, { role: 'ADMIN' }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(await env.auth.users.countActiveOwners(env.client.id), 1);
    const loser = results.find((result) => result.status === 'rejected');
    assert.ok(loser?.status === 'rejected' && loser.reason instanceof ForbiddenError);
  });
});
