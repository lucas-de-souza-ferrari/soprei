import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { OnboardingService } from '../../application/onboarding/onboarding.service.js';
import type { Company, Membership } from '../../domain/index.js';
import { NotFoundError } from '../../shared/errors/index.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import { createLogger } from '../logger/logger.js';
import { createDatabase, type Database } from './database.js';
import { PrismaMembershipRepository } from './repositories/membership.repository.js';
import { PrismaOnboardingStore } from './repositories/onboarding.store.js';

// Spec 030: o estado do assistente é derivado do que existe e isolado por empresa (Postgres real,
// soprei_test). A empresa A tem de tudo, a B está vazia.
const config = loadIntegrationConfig();
const HASH = 'scrypt$1024$8$1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA==';
const everything = (): boolean => true;

let database: Database;
let tenants: TestTenants;
let service: OnboardingService;
let companyA: Company;
let companyB: Company;
let ownerA: Membership;

before(async () => {
  database = createDatabase(config, createLogger(config));
  tenants = new TestTenants(database.prisma);
  service = new OnboardingService(new PrismaOnboardingStore(database.prisma));
  companyA = await tenants.createCompany('onb-a');
  companyB = await tenants.createCompany('onb-b');
  ownerA = await new PrismaMembershipRepository(database.prisma).create(companyA.id, {
    email: `a-${randomBytes(5).toString('hex')}@exemplo.test`,
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

describe('PrismaOnboardingStore (spec 030)', () => {
  it('empresa vazia: tudo false e não dispensado', async () => {
    assert.deepEqual(await service.get(companyB.id, everything), {
      dismissed: false,
      steps: { persona: false, knowledge: false, schedule: false, inventory: false },
    });
  });

  it('persona, documento, serviço ativo e produto ativo viram true; só inativos e "voltar ao padrão" voltam a false', async () => {
    const db = database.prisma;
    await db.company.updateMany({ where: { id: companyA.id }, data: { persona: 'Persona' } });
    await db.knowledgeDocument.create({
      data: {
        companyId: companyA.id,
        title: 'Doc',
        charCount: 3,
        chunkCount: 1,
        preview: 'abc',
        createdByMembershipId: ownerA.id,
      },
    });
    const svc = await db.scheduleService.create({
      data: { companyId: companyA.id, name: 'Corte', durationMinutes: 30, active: false },
    });
    const product = await db.product.create({
      data: {
        companyId: companyA.id,
        sku: 'X-1',
        name: 'Item',
        priceCents: 100,
        quantity: 1,
        searchText: 'item',
        active: false,
      },
    });
    // Só inativos: serviço e estoque ainda pendentes.
    assert.deepEqual((await service.get(companyA.id, everything)).steps, {
      persona: true,
      knowledge: true,
      schedule: false,
      inventory: false,
    });
    await db.scheduleService.updateMany({
      where: { id: svc.id, companyId: companyA.id },
      data: { active: true },
    });
    await db.product.updateMany({
      where: { id: product.id, companyId: companyA.id },
      data: { active: true },
    });
    assert.deepEqual((await service.get(companyA.id, everything)).steps, {
      persona: true,
      knowledge: true,
      schedule: true,
      inventory: true,
    });
    await db.company.updateMany({ where: { id: companyA.id }, data: { persona: null } });
    assert.equal((await service.get(companyA.id, everything)).steps.persona, false);
    await db.company.updateMany({ where: { id: companyA.id }, data: { persona: 'Persona' } });
  });

  it('isolamento: o estado de A não aparece em B e dispensar A não altera B (lido no banco)', async () => {
    assert.equal(
      Object.values((await service.get(companyB.id, everything)).steps).some(Boolean),
      false,
    );
    const dismissed = await service.setDismissed(companyA.id, true, everything);
    assert.equal(dismissed.changed, true);
    assert.equal(dismissed.state.dismissed, true);
    const first = await database.prisma.company.findFirst({
      where: { id: companyA.id },
      select: { onboardingDismissedAt: true },
    });
    assert.ok(first?.onboardingDismissedAt);
    // Repetir é idempotente: a data não muda.
    assert.equal((await service.setDismissed(companyA.id, true, everything)).changed, false);
    const again = await database.prisma.company.findFirst({
      where: { id: companyA.id },
      select: { onboardingDismissedAt: true },
    });
    assert.equal(again?.onboardingDismissedAt?.getTime(), first.onboardingDismissedAt.getTime());
    const rowB = await database.prisma.company.findFirst({
      where: { id: companyB.id },
      select: { onboardingDismissedAt: true },
    });
    assert.equal(rowB?.onboardingDismissedAt, null);
    assert.equal((await service.get(companyB.id, everything)).dismissed, false);
    const reopened = await service.setDismissed(companyA.id, false, everything);
    assert.deepEqual([reopened.changed, reopened.state.dismissed], [true, false]);
    assert.equal((await service.setDismissed(companyA.id, false, everything)).changed, false);
  });

  it('passo sem permissão não é consultado nem devolvido', async () => {
    const state = await service.get(companyA.id, (p) => p === 'persona:manage');
    assert.deepEqual(state.steps, { persona: true });
  });

  it('empresa inexistente: NotFoundError', async () => {
    const ghost = randomUUID();
    await assert.rejects(
      service.get(ghost as Company['id'], everything),
      (error: unknown) => error instanceof NotFoundError,
    );
    await assert.rejects(
      service.setDismissed(ghost as Company['id'], true, everything),
      (error: unknown) => error instanceof NotFoundError,
    );
  });
});
