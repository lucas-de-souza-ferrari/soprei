import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { InvitationExpiryPurger } from '../../application/invitations/invitation-expiry-purger.js';
import { type Company, type InvitationStatus, type Membership } from '../../domain/index.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import { createLogger } from '../logger/logger.js';
import { createDatabase, type Database } from './database.js';
import { PrismaInvitationExpiryRepository } from './repositories/invitation-expiry.repository.js';
import { PrismaMembershipRepository } from './repositories/membership.repository.js';

// Spec 025: o expurgo do e-mail do convidado, contra o Postgres real (soprei_test).
const config = loadIntegrationConfig();
const HASH = 'scrypt$1024$8$1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA==';
const DAY = 24 * 60 * 60_000;

let database: Database;
let tenants: TestTenants;
let repository: PrismaInvitationExpiryRepository;
let companyA: Company;
let companyB: Company;
let ownerA: Membership;
let ownerB: Membership;
let agentA: Membership;

const email = (label: string): string => `${label}-${randomBytes(5).toString('hex')}@exemplo.test`;
const daysAgo = (days: number): Date => new Date(Date.now() - days * DAY);

before(async () => {
  database = createDatabase(config, createLogger(config));
  tenants = new TestTenants(database.prisma);
  repository = new PrismaInvitationExpiryRepository(database.prisma);
  const memberships = new PrismaMembershipRepository(database.prisma);
  companyA = await tenants.createCompany('exp-a');
  companyB = await tenants.createCompany('exp-b');
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

async function seed(
  company: Company,
  inviter: Membership,
  expiredDaysAgo: number,
  status: InvitationStatus = 'PENDING',
) {
  const pending = status === 'PENDING';
  const row = await database.prisma.companyInvitation.create({
    data: {
      companyId: company.id,
      email: pending ? email('p') : null,
      role: 'AGENT',
      status,
      tokenHash: pending ? `h-${randomUUID()}` : null,
      invitedByMembershipId: inviter.id,
      acceptedMembershipId: status === 'ACCEPTED' ? agentA.id : null,
      expiresAt: daysAgo(expiredDaysAgo),
      lastSentAt: daysAgo(expiredDaysAgo + 7),
      closedAt: pending ? null : daysAgo(expiredDaysAgo),
    },
  });
  return row.id;
}

async function stateOf(companyId: string, id: string) {
  return database.prisma.companyInvitation.findFirst({ where: { id, companyId } });
}

describe('expurgo do e-mail do convidado (spec 025)', () => {
  it('fecha como EXPIRED só PENDING vencido há mais de 7 dias, em várias empresas, sem tocar nos demais', async () => {
    const oldA = await seed(companyA, ownerA, 9);
    const oldB = await seed(companyB, ownerB, 8);
    const recent = await seed(companyA, ownerA, 3);
    const live = await seed(companyA, ownerA, -2);
    const accepted = await seed(companyA, ownerA, 20, 'ACCEPTED');
    const revoked = await seed(companyB, ownerB, 20, 'REVOKED');

    const cutoff = daysAgo(7);
    let total = 0;
    for (let round = 0; round < 50; round += 1) {
      const count = await repository.expirePending(cutoff, 100);
      total += count;
      if (count < 100) break;
    }
    assert.ok(total >= 2);

    for (const [companyId, id] of [
      [companyA.id, oldA],
      [companyB.id, oldB],
    ] as const) {
      const row = await stateOf(companyId, id);
      assert.equal(row?.status, 'EXPIRED');
      assert.equal(row.email, null);
      assert.equal(row.tokenHash, null);
      assert.ok(row.closedAt !== null);
    }
    // Vencido há pouco e ainda válido continuam pendentes, com e-mail e hash.
    for (const id of [recent, live]) {
      const row = await stateOf(companyA.id, id);
      assert.equal(row?.status, 'PENDING');
      assert.ok(row.email !== null && row.tokenHash !== null);
    }
    // Aceito e revogado nunca mudam.
    assert.equal((await stateOf(companyA.id, accepted))?.status, 'ACCEPTED');
    assert.equal((await stateOf(companyA.id, accepted))?.acceptedMembershipId, agentA.id);
    assert.equal((await stateOf(companyB.id, revoked))?.status, 'REVOKED');
  });

  it('respeita o tamanho do lote e termina o trabalho em chamadas seguidas', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) ids.push(await seed(companyA, ownerA, 10));
    const cutoff = daysAgo(7);
    const first = await repository.expirePending(cutoff, 2);
    assert.ok(first <= 2, `lote de 2 devolveu ${String(first)}`);
    for (let round = 0; round < 50; round += 1) {
      if ((await repository.expirePending(cutoff, 2)) === 0) break;
    }
    for (const id of ids) assert.equal((await stateOf(companyA.id, id))?.status, 'EXPIRED');
  });

  it('convite aceito DURANTE o expurgo nunca é revertido (SKIP LOCKED e predicado repetido)', async () => {
    const id = await seed(companyA, ownerA, 12);
    const holder = new pg.Client({ connectionString: config.DATABASE_URL });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      // O aceite em curso: fecha o convite e segura a linha sem confirmar ainda.
      await holder.query(
        `UPDATE company_invitations
         SET status = 'ACCEPTED', email = NULL, token_hash = NULL, accepted_membership_id = $2, closed_at = now()
         WHERE id = $1`,
        [id, agentA.id],
      );
      await repository.expirePending(daysAgo(7), 100);
      await holder.query('COMMIT');
    } finally {
      await holder.end();
    }
    const row = await stateOf(companyA.id, id);
    assert.equal(row?.status, 'ACCEPTED');
    assert.equal(row.acceptedMembershipId, agentA.id);
  });

  it('o expurgador (aplicação) devolve só contagens e usa o corte de 7 dias', async () => {
    await seed(companyB, ownerB, 15);
    const summaries: { result: string; expired: number }[] = [];
    const purger = new InvitationExpiryPurger({
      repository,
      onRun: (summary) => summaries.push(summary),
    });
    const summary = await purger.runOnce();
    assert.equal(summary.result, 'ok');
    assert.ok(summary.expired >= 1);
    assert.deepEqual(Object.keys(summary).sort(), ['batches', 'expired', 'result']);
    assert.equal(summaries.length, 1);
  });
});
