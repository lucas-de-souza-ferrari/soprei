import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  type AuditRepository,
  type Company,
  CompanyId,
  type Membership,
  type MembershipRepository,
} from '../../../domain/index.js';
import { DatabaseError, TenantScopeError, ValidationError } from '../../../shared/errors/index.js';
import { loadIntegrationConfig } from '../../../test-support/integration-env.js';
import { TestTenants } from '../../../test-support/tenant-fixtures.js';
import { createLogger } from '../../logger/logger.js';
import { createDatabase, type Database } from '../database.js';
import { PrismaAuditRepository } from './audit.repository.js';
import { PrismaMembershipRepository } from './membership.repository.js';

const config = loadIntegrationConfig();
const HASH = 'scrypt$1024$8$1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA==';

let database: Database;
let tenants: TestTenants;
let memberships: MembershipRepository;
let audit: AuditRepository;
let companyA: Company;
let companyB: Company;
let ownerA: Membership;
let agentA: Membership;
let ownerB: Membership;
const email = (label: string): string => `${label}-${randomBytes(5).toString('hex')}@exemplo.test`;
const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

before(async () => {
  database = createDatabase(config, createLogger(config));
  tenants = new TestTenants(database.prisma);
  memberships = new PrismaMembershipRepository(database.prisma);
  audit = new PrismaAuditRepository(database.prisma);
  companyA = await tenants.createCompany('aud-a');
  companyB = await tenants.createCompany('aud-b');
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

describe('AuditRepository (isolamento entre empresas A e B)', () => {
  it('não expõe update nem delete: a trilha é imutável pela API', () => {
    const methods = Object.getOwnPropertyNames(PrismaAuditRepository.prototype).sort();
    // `countSince` (spec 025) é só leitura de contagem: a trilha continua sem update nem delete.
    assert.deepEqual(methods, ['constructor', 'countSince', 'create', 'forTransaction', 'list']);
    assert.ok(!('update' in audit));
    assert.ok(!('delete' in audit));
  });

  it('cria na empresa do parâmetro e cada empresa lista só os seus eventos, mais recentes primeiro', async () => {
    const first = await audit.create(companyA.id, {
      action: 'MEMBERSHIP_CREATED',
      actorMembershipId: ownerA.id,
      targetMembershipId: agentA.id,
      toRole: 'AGENT',
    });
    await pause(5);
    const second = await audit.create(companyA.id, {
      action: 'MEMBERSHIP_ROLE_CHANGED',
      actorMembershipId: ownerA.id,
      targetMembershipId: agentA.id,
      fromRole: 'AGENT',
      toRole: 'ADMIN',
    });
    const other = await audit.create(companyB.id, {
      action: 'MEMBERSHIP_DISABLED',
      actorMembershipId: ownerB.id,
      targetMembershipId: ownerB.id,
    });

    assert.equal(first.companyId, companyA.id);
    assert.equal(first.fromRole, null);
    assert.equal(first.toRole, 'AGENT');
    const listedA = await audit.list(companyA.id);
    assert.deepEqual(
      listedA.items.map((event) => event.id),
      [second.id, first.id],
    );
    const listedB = await audit.list(companyB.id);
    assert.deepEqual(
      listedB.items.map((event) => event.id),
      [other.id],
    );
    assert.ok(!listedA.items.some((event) => event.id === other.id));
    assert.deepEqual(await audit.list(CompanyId.parse('01900000-0000-7000-8000-000000000000')), {
      items: [],
      nextCursor: null,
    });
  });

  it('pagina por cursor (decrescente), sem repetir nem perder evento; cursor inválido é 400', async () => {
    const fresh = await tenants.createCompany('aud-pag');
    const owner = await memberships.create(fresh.id, {
      email: email('pg'),
      passwordHash: HASH,
      role: 'OWNER',
    });
    const created: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const event = await audit.create(fresh.id, {
        action: 'MEMBERSHIP_PASSWORD_RESET',
        actorMembershipId: owner.id,
        targetMembershipId: owner.id,
      });
      created.push(event.id);
      await pause(3);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await audit.list(fresh.id, {
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...page.items.map((event) => event.id));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor !== undefined);
    assert.equal(pages, 3);
    assert.deepEqual(seen, [...created].reverse());
    await assert.rejects(audit.list(fresh.id, { cursor: 'lixo' }), ValidationError);
    await assert.rejects(audit.list(fresh.id, { limit: 0 }), ValidationError);
    // O cursor de uma empresa não abre os eventos de outro: o filtro por empresa continua no where.
    const firstPage = await audit.list(fresh.id, { limit: 1 });
    assert.deepEqual(
      (
        await audit.list(companyB.id, { limit: 50, cursor: firstPage.nextCursor ?? undefined })
      ).items.every((event) => event.companyId === companyB.id),
      true,
    );
  });

  it('a chave estrangeira composta impede, no banco, evento da empresa A apontar para usuário de B', async () => {
    await assert.rejects(
      audit.create(companyA.id, {
        action: 'MEMBERSHIP_DISABLED',
        actorMembershipId: ownerB.id,
        targetMembershipId: agentA.id,
      }),
      DatabaseError,
    );
    await assert.rejects(
      audit.create(companyA.id, {
        action: 'MEMBERSHIP_DISABLED',
        actorMembershipId: ownerA.id,
        targetMembershipId: ownerB.id,
      }),
      DatabaseError,
    );
    // Nada foi gravado em nenhum das empresas por essas tentativas.
    assert.ok(
      !(await audit.list(companyA.id)).items.some(
        (event) => event.action === 'MEMBERSHIP_DISABLED',
      ),
    );
    assert.ok(
      !(await audit.list(companyB.id)).items.some(
        (event) => event.actorMembershipId === ownerB.id && event.targetMembershipId === agentA.id,
      ),
    );
  });

  it('o usuário referenciado por evento não pode ser apagado (Restrict)', async () => {
    await assert.rejects(memberships.delete(companyA.id, ownerA.id), DatabaseError);
  });

  it('consulta de AuditEvent sem companyId lança TenantScopeError (segunda barreira)', async () => {
    const prisma = database.prisma;
    const attempts: readonly (() => Promise<unknown>)[] = [
      () => prisma.auditEvent.findMany({}),
      () => prisma.auditEvent.findFirst({ where: { action: 'MEMBERSHIP_CREATED' } }),
      () => prisma.auditEvent.count({}),
      () => prisma.auditEvent.deleteMany({}),
      () => prisma.auditEvent.updateMany({ where: {}, data: { action: 'MEMBERSHIP_ENABLED' } }),
      () => prisma.auditEvent.findUnique({ where: { id: '01900000-0000-7000-8000-000000000000' } }),
      () =>
        prisma.auditEvent.create({
          data: {
            action: 'MEMBERSHIP_CREATED',
            actorMembershipId: ownerA.id,
            targetMembershipId: agentA.id,
          } as never,
        }),
    ];
    for (const attempt of attempts) {
      await assert.rejects(attempt, TenantScopeError);
    }
  });
});
