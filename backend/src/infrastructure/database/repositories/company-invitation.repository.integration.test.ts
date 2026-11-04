import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { type Company, type Membership } from '../../../domain/index.js';
import { describeInvitationRepositoryContract } from '../../../test-support/company-invitation-repository-contract.js';
import { loadIntegrationConfig } from '../../../test-support/integration-env.js';
import { TestTenants } from '../../../test-support/tenant-fixtures.js';
import { createLogger } from '../../logger/logger.js';
import { createDatabase, type Database } from '../database.js';
import { PrismaAuditRepository } from './audit.repository.js';
import { PrismaCompanyInvitationRepository } from './company-invitation.repository.js';
import { PrismaMembershipRepository } from './membership.repository.js';

// Spec 025: Postgres real (soprei_test). O mesmo contrato do repositório em memória, mais o que só o
// banco garante: CHECKs, índice único parcial, chaves estrangeiras compostas e a trilha com convite.
const config = loadIntegrationConfig();
const HASH = 'scrypt$1024$8$1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA==';

let database: Database;
let tenants: TestTenants;
let invitations: PrismaCompanyInvitationRepository;
let audit: PrismaAuditRepository;
let memberships: PrismaMembershipRepository;
let companyA: Company;
let companyB: Company;
let ownerA: Membership;
let agentA: Membership;
let ownerB: Membership;

const email = (label: string): string => `${label}-${randomBytes(5).toString('hex')}@exemplo.test`;
const NOW = new Date();
const LATER = new Date(NOW.getTime() + 7 * 24 * 60 * 60_000);

before(async () => {
  database = createDatabase(config, createLogger(config));
  tenants = new TestTenants(database.prisma);
  invitations = new PrismaCompanyInvitationRepository(database.prisma);
  audit = new PrismaAuditRepository(database.prisma);
  memberships = new PrismaMembershipRepository(database.prisma);
  companyA = await tenants.createCompany('inv-a');
  companyB = await tenants.createCompany('inv-b');
  ownerA = await memberships.create(companyA.id, {
    email: email('oa'),
    passwordHash: HASH,
    role: 'OWNER',
  });
  agentA = await memberships.create(companyA.id, { email: email('aa'), passwordHash: HASH });
  ownerB = await memberships.create(companyB.id, {
    email: email('ob'),
    passwordHash: HASH,
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

describeInvitationRepositoryContract('Postgres', () =>
  Promise.resolve({
    repository: invitations,
    companyA: companyA.id,
    companyB: companyB.id,
    inviterA: ownerA.id,
    acceptedA: agentA.id,
    inviterB: ownerB.id,
  }),
);

/** Insere direto (sem o repositório) para provar o que o banco recusa. */
function rawInsert(data: {
  companyId?: string;
  email?: string | null;
  role?: 'OWNER' | 'ADMIN' | 'AGENT' | 'VIEWER';
  status?: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
  tokenHash?: string | null;
  invitedByMembershipId?: string;
  acceptedMembershipId?: string | null;
  closedAt?: Date | null;
  sendCount?: number;
}) {
  const status = data.status ?? 'PENDING';
  return database.prisma.companyInvitation.create({
    data: {
      companyId: data.companyId ?? companyA.id,
      email: data.email === undefined ? email('raw') : data.email,
      role: data.role ?? 'AGENT',
      status,
      tokenHash: data.tokenHash === undefined ? `h-${randomUUID()}` : data.tokenHash,
      invitedByMembershipId: data.invitedByMembershipId ?? ownerA.id,
      acceptedMembershipId: data.acceptedMembershipId ?? null,
      expiresAt: LATER,
      lastSentAt: NOW,
      closedAt: data.closedAt === undefined ? (status === 'PENDING' ? null : NOW) : data.closedAt,
      ...(data.sendCount === undefined ? {} : { sendCount: data.sendCount }),
    },
  });
}

describe('CHECKs do banco em company_invitations', () => {
  it('aceita PENDING com e-mail e hash e ACCEPTED com vínculo, com e-mail e hash nulos', async () => {
    await rawInsert({});
    await rawInsert({
      status: 'ACCEPTED',
      email: null,
      tokenHash: null,
      acceptedMembershipId: agentA.id,
    });
    await rawInsert({ status: 'REVOKED', email: null, tokenHash: null });
    await rawInsert({ status: 'EXPIRED', email: null, tokenHash: null });
  });

  it('recusa convite fechado com e-mail ou com hash', async () => {
    await assert.rejects(rawInsert({ status: 'REVOKED', tokenHash: null }));
    await assert.rejects(rawInsert({ status: 'EXPIRED', email: null }));
    await assert.rejects(
      rawInsert({
        status: 'ACCEPTED',
        acceptedMembershipId: agentA.id,
        email: null,
        tokenHash: 'x',
      }),
    );
  });

  it('recusa PENDING sem e-mail ou sem hash', async () => {
    await assert.rejects(rawInsert({ email: null }));
    await assert.rejects(rawInsert({ tokenHash: null }));
  });

  it('recusa ACCEPTED sem vínculo e vínculo em convite que não é ACCEPTED', async () => {
    await assert.rejects(rawInsert({ status: 'ACCEPTED', email: null, tokenHash: null }));
    await assert.rejects(
      rawInsert({
        status: 'REVOKED',
        email: null,
        tokenHash: null,
        acceptedMembershipId: agentA.id,
      }),
    );
  });

  it('recusa o papel OWNER, PENDING com closed_at e send_count fora de 1 a 6', async () => {
    await assert.rejects(rawInsert({ role: 'OWNER' }));
    await assert.rejects(rawInsert({ closedAt: NOW }));
    await assert.rejects(rawInsert({ sendCount: 0 }));
    await assert.rejects(rawInsert({ sendCount: 7 }));
    await rawInsert({ sendCount: 6 });
  });

  it('recusa e-mail com mais de 254 caracteres', async () => {
    await assert.rejects(rawInsert({ email: `${'a'.repeat(250)}@x.test` }));
  });

  it('o índice parcial recusa dois PENDING do mesmo e-mail e empresa, mas não bloqueia fechado nem outra empresa', async () => {
    const address = email('uniq');
    const first = await rawInsert({ email: address });
    await assert.rejects(rawInsert({ email: address }));
    await rawInsert({ email: address, companyId: companyB.id, invitedByMembershipId: ownerB.id });
    await database.prisma.companyInvitation.updateMany({
      where: { id: first.id, companyId: companyA.id },
      data: { status: 'REVOKED', email: null, tokenHash: null, closedAt: NOW },
    });
    await rawInsert({ email: address });
  });
});

describe('chaves estrangeiras compostas com company_id', () => {
  it('recusa invited_by_membership_id e accepted_membership_id de OUTRA empresa', async () => {
    await assert.rejects(rawInsert({ invitedByMembershipId: ownerB.id }));
    await assert.rejects(
      rawInsert({
        status: 'ACCEPTED',
        email: null,
        tokenHash: null,
        acceptedMembershipId: ownerB.id,
      }),
    );
  });

  it('o repositório recusa convidador de outra empresa pelo próprio banco', async () => {
    await assert.rejects(
      invitations.create(companyA.id, {
        email: email('fk'),
        role: 'AGENT',
        tokenHash: 'h',
        invitedByMembershipId: ownerB.id,
        expiresAt: LATER,
        now: NOW,
      }),
    );
  });

  it('o evento de auditoria só aponta para convite da mesma empresa', async () => {
    const own = await rawInsert({});
    const foreign = await rawInsert({
      companyId: companyB.id,
      invitedByMembershipId: ownerB.id,
    });
    await audit.create(companyA.id, {
      action: 'INVITATION_CREATED',
      actorMembershipId: ownerA.id,
      invitationId: own.id,
      toRole: 'AGENT',
    });
    await assert.rejects(
      audit.create(companyA.id, {
        action: 'INVITATION_CREATED',
        actorMembershipId: ownerA.id,
        invitationId: foreign.id,
        toRole: 'AGENT',
      }),
    );
  });
});

describe('CHECK por ação em audit_events', () => {
  async function seeded() {
    return rawInsert({});
  }

  it('INVITATION_CREATED/RESENT/REVOKED exigem o convite e nenhum alvo; ACCEPTED exige convite e alvo', async () => {
    const invitation = await seeded();
    for (const action of [
      'INVITATION_CREATED',
      'INVITATION_RESENT',
      'INVITATION_REVOKED',
    ] as const) {
      await audit.create(companyA.id, {
        action,
        actorMembershipId: ownerA.id,
        invitationId: invitation.id,
        toRole: 'AGENT',
      });
      // Sem o convite, ou com alvo, o banco recusa.
      await assert.rejects(audit.create(companyA.id, { action, actorMembershipId: ownerA.id }));
      await assert.rejects(
        audit.create(companyA.id, {
          action,
          actorMembershipId: ownerA.id,
          invitationId: invitation.id,
          targetMembershipId: agentA.id,
        }),
      );
    }
    await audit.create(companyA.id, {
      action: 'INVITATION_ACCEPTED',
      actorMembershipId: agentA.id,
      targetMembershipId: agentA.id,
      invitationId: invitation.id,
      toRole: 'AGENT',
    });
    await assert.rejects(
      audit.create(companyA.id, {
        action: 'INVITATION_ACCEPTED',
        actorMembershipId: agentA.id,
        invitationId: invitation.id,
      }),
    );
    await assert.rejects(
      audit.create(companyA.id, {
        action: 'INVITATION_ACCEPTED',
        actorMembershipId: agentA.id,
        targetMembershipId: agentA.id,
      }),
    );
  });

  it('MEMBERSHIP_* e CHANNEL_* recusam invitation_id e seguem válidos sem ele', async () => {
    const invitation = await seeded();
    await audit.create(companyA.id, {
      action: 'MEMBERSHIP_CREATED',
      actorMembershipId: ownerA.id,
      targetMembershipId: agentA.id,
    });
    await audit.create(companyA.id, { action: 'CHANNEL_CONNECTED', actorMembershipId: ownerA.id });
    await assert.rejects(
      audit.create(companyA.id, {
        action: 'MEMBERSHIP_CREATED',
        actorMembershipId: ownerA.id,
        targetMembershipId: agentA.id,
        invitationId: invitation.id,
      }),
    );
    await assert.rejects(
      audit.create(companyA.id, {
        action: 'CHANNEL_CONNECTED',
        actorMembershipId: ownerA.id,
        invitationId: invitation.id,
      }),
    );
  });
});

describe('isolamento e contagem de envios', () => {
  it('o repositório chamado com a empresa errada não lê, renova nem fecha', async () => {
    const created = await invitations.create(companyA.id, {
      email: email('iso'),
      role: 'VIEWER',
      tokenHash: 'h',
      invitedByMembershipId: ownerA.id,
      expiresAt: LATER,
      now: NOW,
    });
    await assert.rejects(invitations.findById(companyB.id, created.id));
    assert.equal(
      await invitations.renew(companyB.id, created.id, {
        tokenHash: 'x',
        expiresAt: LATER,
        lastSentAt: NOW,
      }),
      null,
    );
    assert.equal(
      await invitations.close(companyB.id, created.id, { status: 'REVOKED', closedAt: NOW }),
      false,
    );
    const intact = await invitations.findById(companyA.id, created.id);
    assert.equal(intact.status, 'PENDING');
    assert.equal(intact.tokenHash, 'h');
    assert.equal(intact.sendCount, 1);
  });

  it('countSince conta só os eventos pedidos, da empresa, do ator e da janela', async () => {
    const fresh = await tenants.createCompany('inv-count');
    const owner = await memberships.create(fresh.id, {
      email: email('oc'),
      passwordHash: HASH,
      role: 'OWNER',
    });
    const other = await memberships.create(fresh.id, {
      email: email('ac'),
      passwordHash: HASH,
      role: 'ADMIN',
    });
    const invitation = await invitations.create(fresh.id, {
      email: email('c'),
      role: 'AGENT',
      tokenHash: 'h',
      invitedByMembershipId: owner.id,
      expiresAt: LATER,
      now: NOW,
    });
    const record = (action: 'INVITATION_CREATED' | 'INVITATION_RESENT', actor: Membership) =>
      audit.create(fresh.id, {
        action,
        actorMembershipId: actor.id,
        invitationId: invitation.id,
        toRole: 'AGENT',
      });
    await record('INVITATION_CREATED', owner);
    await record('INVITATION_RESENT', owner);
    await record('INVITATION_RESENT', other);
    const since = new Date(Date.now() - 60_000);
    const actions = ['INVITATION_CREATED', 'INVITATION_RESENT'] as const;
    assert.equal(await audit.countSince(fresh.id, { actions, since }), 3);
    assert.equal(
      await audit.countSince(fresh.id, { actions, since, actorMembershipId: owner.id }),
      2,
    );
    assert.equal(await audit.countSince(fresh.id, { actions: ['INVITATION_RESENT'], since }), 2);
    // Janela no futuro e empresa vizinha: zero.
    assert.equal(
      await audit.countSince(fresh.id, { actions, since: new Date(Date.now() + 60_000) }),
      0,
    );
    assert.equal(await audit.countSince(companyB.id, { actions: ['INVITATION_RESENT'], since }), 0);
  });
});
