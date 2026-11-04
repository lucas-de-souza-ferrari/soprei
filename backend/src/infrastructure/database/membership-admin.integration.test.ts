import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { deriveLoginLockSecret } from '../../application/auth/auth.service.js';
import type { MembershipIdentity } from '../../application/auth/identity.js';
import { MembershipAdminService } from '../../application/memberships/membership-admin.service.js';
import {
  type Company,
  CompanyId,
  type Membership,
  type MembershipRole,
} from '../../domain/index.js';
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
import { PrismaMembershipAdminUnitOfWork } from './repositories/membership-admin-unit-of-work.js';
import { PrismaMembershipRepository } from './repositories/membership.repository.js';

const config = loadIntegrationConfig();
const HASH = 'fake$hash-de-teste';

let database: Database;
let tenants: TestTenants;
let memberships: PrismaMembershipRepository;
let audit: PrismaAuditRepository;
let unitOfWork: PrismaMembershipAdminUnitOfWork;
let service: MembershipAdminService;
let sessions: InMemorySessionStore;

const email = (label: string): string => `${label}-${randomBytes(5).toString('hex')}@exemplo.test`;
const identity = (membership: Membership): MembershipIdentity => ({
  kind: 'membership',
  membershipId: membership.id,
  companyId: membership.companyId,
  role: membership.role,
  sessionId: 'sessao-de-teste',
});
const seed = (company: Company, role: MembershipRole): Promise<Membership> =>
  memberships.create(company.id, { email: email(role.toLowerCase()), passwordHash: HASH, role });

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
  memberships = new PrismaMembershipRepository(database.prisma);
  audit = new PrismaAuditRepository(database.prisma);
  unitOfWork = new PrismaMembershipAdminUnitOfWork(database.prisma);
  sessions = new InMemorySessionStore();
  service = new MembershipAdminService({
    memberships,
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

describe('MembershipAdminUnitOfWork (Postgres real)', () => {
  it('lockCompany serializa: a segunda transação só entra depois do commit da primeira', async () => {
    const company = await tenants.createCompany('uow-lock');
    const events: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = unitOfWork.run(async (tx) => {
      await tx.lockCompany(company.id);
      events.push('A:travou');
      await gate;
      events.push('A:vai-confirmar');
    });
    await until(() => events.includes('A:travou'));
    const second = unitOfWork.run(async (tx) => {
      await tx.lockCompany(company.id);
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

  it('empresas diferentes não se bloqueiam entre si', async () => {
    const a = await tenants.createCompany('uow-lock-a');
    const b = await tenants.createCompany('uow-lock-b');
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const first = unitOfWork.run(async (tx) => {
      await tx.lockCompany(a.id);
      held = true;
      await gate;
    });
    await until(() => held);
    await unitOfWork.run((tx) => tx.lockCompany(b.id));
    release?.();
    await first;
  });

  it('o bloqueio não impede gravar conversa do mesma empresa (FOR NO KEY UPDATE não toma o KEY SHARE das FKs)', async () => {
    const company = await tenants.createCompany('uow-keyshare');
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const holder = unitOfWork.run(async (tx) => {
      await tx.lockCompany(company.id);
      held = true;
      await gate;
    });
    await until(() => held);
    try {
      const created = await Promise.race([
        database.prisma.conversation
          .create({ data: { companyId: company.id, contactRef: 'contato-livre' } })
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

  it('lockCompany de empresa inexistente é NotFoundError', async () => {
    await assert.rejects(
      unitOfWork.run((tx) =>
        tx.lockCompany(CompanyId.parse('01900000-0000-7000-8000-000000000000')),
      ),
      NotFoundError,
    );
  });

  it('atomicidade: falha da trilha desfaz a mudança do usuário, e falha do usuário desfaz a trilha', async () => {
    const company = await tenants.createCompany('uow-atomic');
    const other = await tenants.createCompany('uow-atomic-b');
    const owner = await seed(company, 'OWNER');
    const target = await seed(company, 'AGENT');
    const foreign = await seed(other, 'OWNER');

    // Trilha falha (ator de outra empresa: viola a FK composta) depois de mudar o usuário.
    await assert.rejects(
      unitOfWork.run(async (tx) => {
        await tx.memberships.update(company.id, target.id, { role: 'VIEWER' });
        await tx.audit.create(company.id, {
          action: 'MEMBERSHIP_ROLE_CHANGED',
          actorMembershipId: foreign.id,
          targetMembershipId: target.id,
          fromRole: 'AGENT',
          toRole: 'VIEWER',
        });
      }),
      DatabaseError,
    );
    assert.equal((await memberships.findById(company.id, target.id)).role, 'AGENT');
    assert.equal((await audit.list(company.id)).items.length, 0);

    // Usuário falha (e-mail repetido) depois de gravar a trilha.
    await assert.rejects(
      unitOfWork.run(async (tx) => {
        await tx.audit.create(company.id, {
          action: 'MEMBERSHIP_DISABLED',
          actorMembershipId: owner.id,
          targetMembershipId: target.id,
        });
        await tx.memberships.create(company.id, { email: target.email, passwordHash: HASH });
      }),
      ConflictError,
    );
    assert.equal((await audit.list(company.id)).items.length, 0);
  });
});

describe('MembershipAdminService com Postgres real', () => {
  it('dois OWNER se rebaixando SIMULTANEAMENTE: exatamente um pedido tem sucesso e sobra um OWNER ativo (repetido várias vezes)', async () => {
    for (let round = 0; round < 12; round += 1) {
      const company = await tenants.createCompany(`race-${String(round)}`);
      const first = await seed(company, 'OWNER');
      const second = await seed(company, 'OWNER');
      const results = await Promise.allSettled([
        service.updateMembership(identity(first), second.id, { role: 'ADMIN' }),
        service.updateMembership(identity(second), first.id, { role: 'ADMIN' }),
      ]);
      const ok = results.filter((result) => result.status === 'fulfilled');
      const failed = results.filter((result) => result.status === 'rejected');
      assert.equal(ok.length, 1, `rodada ${String(round)}: exatamente um sucesso`);
      assert.equal(failed.length, 1);
      // O perdedor é barrado no próprio papel (relido do banco depois do bloqueio) ou pela regra do
      // último OWNER; nunca passa.
      const reason = (failed[0] as PromiseRejectedResult).reason as unknown;
      assert.ok(reason instanceof ForbiddenError || reason instanceof ConflictError);
      assert.equal(await memberships.countActiveOwners(company.id), 1, `rodada ${String(round)}`);
      assert.equal((await audit.list(company.id)).items.length, 1);
    }
  });

  it('dois OWNER se desativando simultaneamente: um OWNER ativo sobra', async () => {
    for (let round = 0; round < 6; round += 1) {
      const company = await tenants.createCompany(`race-d-${String(round)}`);
      const first = await seed(company, 'OWNER');
      const second = await seed(company, 'OWNER');
      const results = await Promise.allSettled([
        service.updateMembership(identity(first), second.id, { status: 'DISABLED' }),
        service.updateMembership(identity(second), first.id, { status: 'DISABLED' }),
      ]);
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(await memberships.countActiveOwners(company.id), 1);
    }
  });

  it('promover e desativar o mesmo usuário ao mesmo tempo: serializados, resultado consistente e a regra vale', async () => {
    const company = await tenants.createCompany('race-mix');
    const owner = await seed(company, 'OWNER');
    const owner2 = await seed(company, 'OWNER');
    const agent = await seed(company, 'AGENT');
    const results = await Promise.allSettled([
      service.updateMembership(identity(owner), agent.id, { role: 'OWNER' }),
      service.updateMembership(identity(owner2), agent.id, { status: 'DISABLED' }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 2);
    const final = await memberships.findById(company.id, agent.id);
    assert.equal(final.status, 'DISABLED');
    assert.equal(final.role, 'OWNER');
    assert.equal(await memberships.countActiveOwners(company.id), 2);
  });

  it('o fluxo completo grava a trilha com ator, alvo, ação e papéis, e o isolamento vale no banco', async () => {
    const company = await tenants.createCompany('flow-a');
    const other = await tenants.createCompany('flow-b');
    const owner = await seed(company, 'OWNER');
    const alien = await seed(other, 'AGENT');
    const created = await service.createMembership(identity(owner), {
      email: email('novo'),
      password: 'uma-senha-forte-de-teste-1',
      role: 'AGENT',
    });
    await service.updateMembership(identity(owner), created.id, { role: 'ADMIN' });
    await service.updateMembership(identity(owner), created.id, { status: 'DISABLED' });
    await service.resetPassword(identity(owner), created.id, 'outra-senha-forte-de-teste-2');
    const events = (await audit.list(company.id)).items;
    assert.deepEqual(events.map((event) => event.action).reverse(), [
      'MEMBERSHIP_CREATED',
      'MEMBERSHIP_ROLE_CHANGED',
      'MEMBERSHIP_DISABLED',
      'MEMBERSHIP_PASSWORD_RESET',
    ]);
    assert.ok(
      events.every(
        (event) => event.companyId === company.id && event.actorMembershipId === owner.id,
      ),
    );
    assert.equal((await audit.list(other.id)).items.length, 0);
    await assert.rejects(
      service.updateMembership(identity(owner), alien.id, { role: 'VIEWER' }),
      NotFoundError,
    );
    assert.equal((await memberships.findById(other.id, alien.id)).role, 'AGENT');
    // A senha só é gravada como hash (o fake devolve um prefixo reconhecível).
    const credentials = await memberships.findCredentialsById(company.id, created.id);
    assert.match(credentials.passwordHash, /^fake\$/);
  });
});
