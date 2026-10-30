import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  type AuditRepository,
  type Client,
  ClientId,
  type User,
  type UserRepository,
} from '../../../domain/index.js';
import { DatabaseError, TenantScopeError, ValidationError } from '../../../shared/errors/index.js';
import { loadIntegrationConfig } from '../../../test-support/integration-env.js';
import { TestTenants } from '../../../test-support/tenant-fixtures.js';
import { createLogger } from '../../logger/logger.js';
import { createDatabase, type Database } from '../database.js';
import { PrismaAuditRepository } from './audit.repository.js';
import { PrismaUserRepository } from './user.repository.js';

const config = loadIntegrationConfig();
const HASH = 'scrypt$1024$8$1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA==';

let database: Database;
let tenants: TestTenants;
let users: UserRepository;
let audit: AuditRepository;
let clientA: Client;
let clientB: Client;
let ownerA: User;
let agentA: User;
let ownerB: User;
const email = (label: string): string => `${label}-${randomBytes(5).toString('hex')}@exemplo.test`;
const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

before(async () => {
  database = createDatabase(config, createLogger(config));
  tenants = new TestTenants(database.prisma);
  users = new PrismaUserRepository(database.prisma);
  audit = new PrismaAuditRepository(database.prisma);
  clientA = await tenants.createClient('aud-a');
  clientB = await tenants.createClient('aud-b');
  ownerA = await users.create(clientA.id, {
    email: email('oa'),
    passwordHash: HASH,
    role: 'OWNER',
  });
  agentA = await users.create(clientA.id, { email: email('aa'), passwordHash: HASH });
  ownerB = await users.create(clientB.id, {
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

describe('AuditRepository (isolamento entre clientes A e B)', () => {
  it('não expõe update nem delete: a trilha é imutável pela API', () => {
    const methods = Object.getOwnPropertyNames(PrismaAuditRepository.prototype).sort();
    assert.deepEqual(methods, ['constructor', 'create', 'forTransaction', 'list']);
    assert.ok(!('update' in audit));
    assert.ok(!('delete' in audit));
  });

  it('cria no cliente do parâmetro e cada cliente lista só os seus eventos, mais recentes primeiro', async () => {
    const first = await audit.create(clientA.id, {
      action: 'USER_CREATED',
      actorUserId: ownerA.id,
      targetUserId: agentA.id,
      toRole: 'AGENT',
    });
    await pause(5);
    const second = await audit.create(clientA.id, {
      action: 'USER_ROLE_CHANGED',
      actorUserId: ownerA.id,
      targetUserId: agentA.id,
      fromRole: 'AGENT',
      toRole: 'ADMIN',
    });
    const other = await audit.create(clientB.id, {
      action: 'USER_DISABLED',
      actorUserId: ownerB.id,
      targetUserId: ownerB.id,
    });

    assert.equal(first.clientId, clientA.id);
    assert.equal(first.fromRole, null);
    assert.equal(first.toRole, 'AGENT');
    const listedA = await audit.list(clientA.id);
    assert.deepEqual(
      listedA.items.map((event) => event.id),
      [second.id, first.id],
    );
    const listedB = await audit.list(clientB.id);
    assert.deepEqual(
      listedB.items.map((event) => event.id),
      [other.id],
    );
    assert.ok(!listedA.items.some((event) => event.id === other.id));
    assert.deepEqual(await audit.list(ClientId.parse('01900000-0000-7000-8000-000000000000')), {
      items: [],
      nextCursor: null,
    });
  });

  it('pagina por cursor (decrescente), sem repetir nem perder evento; cursor inválido é 400', async () => {
    const fresh = await tenants.createClient('aud-pag');
    const owner = await users.create(fresh.id, {
      email: email('pg'),
      passwordHash: HASH,
      role: 'OWNER',
    });
    const created: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const event = await audit.create(fresh.id, {
        action: 'USER_PASSWORD_RESET',
        actorUserId: owner.id,
        targetUserId: owner.id,
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
    // O cursor de um cliente não abre os eventos de outro: o filtro por cliente continua no where.
    const firstPage = await audit.list(fresh.id, { limit: 1 });
    assert.deepEqual(
      (
        await audit.list(clientB.id, { limit: 50, cursor: firstPage.nextCursor ?? undefined })
      ).items.every((event) => event.clientId === clientB.id),
      true,
    );
  });

  it('a chave estrangeira composta impede, no banco, evento do cliente A apontar para usuário de B', async () => {
    await assert.rejects(
      audit.create(clientA.id, {
        action: 'USER_DISABLED',
        actorUserId: ownerB.id,
        targetUserId: agentA.id,
      }),
      DatabaseError,
    );
    await assert.rejects(
      audit.create(clientA.id, {
        action: 'USER_DISABLED',
        actorUserId: ownerA.id,
        targetUserId: ownerB.id,
      }),
      DatabaseError,
    );
    // Nada foi gravado em nenhum dos clientes por essas tentativas.
    assert.ok(
      !(await audit.list(clientA.id)).items.some((event) => event.action === 'USER_DISABLED'),
    );
    assert.ok(
      !(await audit.list(clientB.id)).items.some(
        (event) => event.actorUserId === ownerB.id && event.targetUserId === agentA.id,
      ),
    );
  });

  it('o usuário referenciado por evento não pode ser apagado (Restrict)', async () => {
    await assert.rejects(users.delete(clientA.id, ownerA.id), DatabaseError);
  });

  it('consulta de AuditEvent sem clientId lança TenantScopeError (segunda barreira)', async () => {
    const prisma = database.prisma;
    const attempts: readonly (() => Promise<unknown>)[] = [
      () => prisma.auditEvent.findMany({}),
      () => prisma.auditEvent.findFirst({ where: { action: 'USER_CREATED' } }),
      () => prisma.auditEvent.count({}),
      () => prisma.auditEvent.deleteMany({}),
      () => prisma.auditEvent.updateMany({ where: {}, data: { action: 'USER_ENABLED' } }),
      () => prisma.auditEvent.findUnique({ where: { id: '01900000-0000-7000-8000-000000000000' } }),
      () =>
        prisma.auditEvent.create({
          data: {
            action: 'USER_CREATED',
            actorUserId: ownerA.id,
            targetUserId: agentA.id,
          } as never,
        }),
    ];
    for (const attempt of attempts) {
      await assert.rejects(attempt, TenantScopeError);
    }
  });
});
