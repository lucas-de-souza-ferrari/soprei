import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  canManageRole,
  type Company,
  type Membership,
  MEMBERSHIP_ROLES,
  type MembershipRepository,
  type MembershipRole,
} from '../../domain/index.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../shared/errors/index.js';
import { buildTestAuth, type TestAuth } from '../../test-support/in-memory-auth.js';
import { captureLogs, type LogCapture } from '../../test-support/log-capture.js';
import type { MembershipIdentity } from '../auth/identity.js';
import type { MembershipAdminTransaction } from '../ports/membership-admin-unit-of-work.js';
import { LAST_OWNER_CODE, MembershipAdminService } from './membership-admin.service.js';

const PASSWORD = 'uma-senha-forte-de-teste-1';

interface Env {
  auth: TestAuth;
  logs: LogCapture;
  company: Company;
  other: Company;
}

async function setup(): Promise<Env> {
  const logs = captureLogs();
  const auth = buildTestAuth({ logger: logs.logger });
  const company = await auth.companies.create({ name: 'A', slug: 'empresa-a' });
  const other = await auth.companies.create({ name: 'B', slug: 'empresa-b' });
  return { auth, logs, company, other };
}

async function seed(
  env: Env,
  role: MembershipRole,
  company: Company = env.company,
): Promise<Membership> {
  return env.auth.memberships.create(company.id, {
    email: `${role.toLowerCase()}-${Math.random().toString(36).slice(2)}@exemplo.test`,
    passwordHash: await env.auth.hasher.hash(PASSWORD),
    role,
  });
}

function identity(
  membership: Membership,
  roleClaim: MembershipRole = membership.role,
): MembershipIdentity {
  return {
    kind: 'membership',
    membershipId: membership.id,
    companyId: membership.companyId,
    role: roleClaim,
    sessionId: 'sessao-de-teste',
  };
}

describe('MembershipAdminService: hierarquia reaplicada no service (matriz completa)', () => {
  let env: Env;
  beforeEach(async () => {
    env = await setup();
  });

  it('mudar papel: ator x papel atual do alvo x papel novo, exatamente como canManageRole', async () => {
    for (const actorRole of MEMBERSHIP_ROLES) {
      for (const targetRole of MEMBERSHIP_ROLES) {
        for (const newRole of MEMBERSHIP_ROLES) {
          if (newRole === targetRole) continue;
          const actor = await seed(env, actorRole);
          // Um OWNER de reserva garante que a regra do último OWNER nunca é o motivo da recusa.
          await seed(env, 'OWNER');
          const target = await seed(env, targetRole);
          const allowed =
            (actorRole === 'OWNER' || actorRole === 'ADMIN') &&
            canManageRole(actorRole, targetRole) &&
            canManageRole(actorRole, newRole);
          const run = env.auth.membershipAdmin.updateMembership(identity(actor), target.id, {
            role: newRole,
          });
          if (allowed) {
            assert.equal((await run).role, newRole, `${actorRole} ${targetRole}->${newRole}`);
          } else {
            await assert.rejects(run, ForbiddenError, `${actorRole} ${targetRole}->${newRole}`);
            assert.equal(
              (await env.auth.memberships.findById(env.company.id, target.id)).role,
              targetRole,
            );
          }
        }
      }
    }
  });

  it('desativar e redefinir senha: só quem gerencia o papel atual do alvo', async () => {
    for (const actorRole of MEMBERSHIP_ROLES) {
      for (const targetRole of MEMBERSHIP_ROLES) {
        const actor = await seed(env, actorRole);
        await seed(env, 'OWNER');
        const target = await seed(env, targetRole);
        const allowed = canManageRole(actorRole, targetRole);
        for (const run of [
          () =>
            env.auth.membershipAdmin.updateMembership(identity(actor), target.id, {
              status: 'DISABLED',
            }),
          () => env.auth.membershipAdmin.resetPassword(identity(actor), target.id, PASSWORD),
        ]) {
          if (allowed) await run();
          else await assert.rejects(run(), ForbiddenError, `${actorRole} -> ${targetRole}`);
        }
      }
    }
  });

  it('criar: só atribui papel que o ator gerencia; AGENT e VIEWER nunca criam', async () => {
    for (const actorRole of MEMBERSHIP_ROLES) {
      for (const role of MEMBERSHIP_ROLES) {
        const actor = await seed(env, actorRole);
        const run = () =>
          env.auth.membershipAdmin.createMembership(identity(actor), {
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
      env.auth.membershipAdmin.updateMembership(stale, admin.id, { role: 'VIEWER' }),
      ForbiddenError,
    );
    await assert.rejects(
      env.auth.membershipAdmin.createMembership(stale, {
        email: 'x@exemplo.test',
        password: PASSWORD,
        role: 'OWNER',
      }),
      ForbiddenError,
    );
    // Token que diz AGENT não permite nem chegar ao banco.
    await assert.rejects(
      env.auth.membershipAdmin.updateMembership(identity(owner, 'AGENT'), agent.id, {
        role: 'VIEWER',
      }),
      ForbiddenError,
    );
    assert.equal((await env.auth.memberships.findById(env.company.id, admin.id)).role, 'ADMIN');
    assert.equal((await env.auth.memberships.findById(env.company.id, agent.id)).role, 'AGENT');
  });

  it('ator desativado ou removido não age com token ainda válido', async () => {
    const owner = await seed(env, 'OWNER');
    const target = await seed(env, 'AGENT');
    await env.auth.memberships.update(env.company.id, owner.id, { status: 'DISABLED' });
    await assert.rejects(
      env.auth.membershipAdmin.updateMembership(identity(owner), target.id, { role: 'VIEWER' }),
      ForbiddenError,
    );
    await env.auth.memberships.delete(env.company.id, owner.id);
    await assert.rejects(
      env.auth.membershipAdmin.resetPassword(identity(owner), target.id, PASSWORD),
      ForbiddenError,
    );
  });

  it('o CompanyId é o do ator: usuário de outra empresa é NotFoundError e nada muda', async () => {
    const owner = await seed(env, 'OWNER');
    const alien = await seed(env, 'AGENT', env.other);
    await assert.rejects(
      env.auth.membershipAdmin.updateMembership(identity(owner), alien.id, { role: 'VIEWER' }),
      NotFoundError,
    );
    await assert.rejects(
      env.auth.membershipAdmin.resetPassword(identity(owner), alien.id, PASSWORD),
      NotFoundError,
    );
    assert.equal((await env.auth.memberships.findById(env.other.id, alien.id)).role, 'AGENT');
    assert.equal(env.auth.audit.events.length, 0);
    const page = await env.auth.membershipAdmin.listMemberships(identity(owner));
    assert.ok(page.items.every((membership) => membership.id !== alien.id));
  });
});

describe('MembershipAdminService: bloqueio da empresa e regra do último OWNER', () => {
  let env: Env;
  beforeEach(async () => {
    env = await setup();
  });

  /** Serviço cujo `countActiveOwners` devolve o número informado e registra a ordem das chamadas. */
  function withOwnerCount(count: number): { service: MembershipAdminService; calls: string[] } {
    const calls: string[] = [];
    const wrap = (tx: MembershipAdminTransaction): MembershipAdminTransaction => {
      const memberships: MembershipRepository = Object.create(
        tx.memberships,
      ) as MembershipRepository;
      return {
        audit: tx.audit,
        memberships: Object.assign(memberships, {
          findById: (...args: Parameters<MembershipRepository['findById']>) => {
            calls.push('findById');
            return tx.memberships.findById(...args);
          },
          countActiveOwners: () => {
            calls.push('countActiveOwners');
            return Promise.resolve(count);
          },
        }),
        lockCompany: async (companyId) => {
          calls.push('lock');
          await tx.lockCompany(companyId);
        },
      };
    };
    const service = new MembershipAdminService({
      memberships: env.auth.memberships,
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
        service.updateMembership(identity(actor), target.id, patch),
        (error: unknown) =>
          error instanceof ConflictError &&
          error.code === LAST_OWNER_CODE &&
          error.statusCode === 409,
      );
    }
    assert.equal((await env.auth.memberships.findById(env.company.id, target.id)).role, 'OWNER');
    assert.equal((await env.auth.memberships.findById(env.company.id, target.id)).status, 'ACTIVE');
    assert.equal(env.auth.audit.events.length, 0);
  });

  it('com mais de um OWNER ativo a mesma operação passa', async () => {
    const actor = await seed(env, 'OWNER');
    const target = await seed(env, 'OWNER');
    const { service } = withOwnerCount(2);
    assert.equal(
      (await service.updateMembership(identity(actor), target.id, { role: 'AGENT' })).role,
      'AGENT',
    );
  });

  it('a regra não bloqueia o que não tira um OWNER ativo (reativar, promover, mudar AGENT)', async () => {
    const actor = await seed(env, 'OWNER');
    const agent = await seed(env, 'AGENT');
    const { service } = withOwnerCount(1);
    assert.equal(
      (await service.updateMembership(identity(actor), agent.id, { role: 'ADMIN' })).role,
      'ADMIN',
    );
    assert.equal(
      (await service.updateMembership(identity(actor), agent.id, { role: 'OWNER' })).role,
      'OWNER',
    );
  });

  it('toda escrita trava a empresa ANTES de ler o ator, e a contagem de OWNER vem depois do bloqueio', async () => {
    const actor = await seed(env, 'OWNER');
    const target = await seed(env, 'OWNER');
    const { service, calls } = withOwnerCount(5);
    await service.updateMembership(identity(actor), target.id, { role: 'AGENT' });
    assert.equal(calls[0], 'lock');
    assert.ok(calls.indexOf('countActiveOwners') > calls.indexOf('lock'));

    const before = env.auth.unitOfWork.lockCalls;
    await service.createMembership(identity(actor), {
      email: 'n@exemplo.test',
      password: PASSWORD,
      role: 'AGENT',
    });
    await service.resetPassword(identity(actor), target.id, PASSWORD);
    assert.equal(
      env.auth.unitOfWork.lockCalls,
      before + 2,
      'criar e redefinir também travam a empresa',
    );
  });

  it('operações simultâneas do mesma empresa são serializadas (a unidade de trabalho em memória faz o papel do bloqueio)', async () => {
    const first = await seed(env, 'OWNER');
    const second = await seed(env, 'OWNER');
    const results = await Promise.allSettled([
      env.auth.membershipAdmin.updateMembership(identity(first), second.id, { role: 'ADMIN' }),
      env.auth.membershipAdmin.updateMembership(identity(second), first.id, { role: 'ADMIN' }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(await env.auth.memberships.countActiveOwners(env.company.id), 1);
    const loser = results.find((result) => result.status === 'rejected');
    assert.ok(loser?.status === 'rejected' && loser.reason instanceof ForbiddenError);
  });
});

describe('MembershipAdminService: hashes pagos pela administração usam a fila de administração', () => {
  it('criar, redefinir e trocar a própria senha pedem lane admin ao hasher', async () => {
    const env = await setup();
    const owner = await seed(env, 'OWNER');
    const agent = await seed(env, 'AGENT');
    env.auth.hasher.lanes.length = 0;
    await env.auth.membershipAdmin.createMembership(identity(owner), {
      email: 'lane@exemplo.test',
      password: PASSWORD,
      role: 'AGENT',
    });
    await env.auth.membershipAdmin.resetPassword(identity(owner), agent.id, PASSWORD);
    await env.auth.membershipAdmin.changeOwnPassword(identity(owner), {
      currentPassword: PASSWORD,
      newPassword: PASSWORD,
    });
    assert.deepEqual(env.auth.hasher.lanes, ['admin', 'admin', 'admin', 'admin']);
  });
});
