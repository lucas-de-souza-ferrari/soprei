import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { InventoryService } from '../../application/inventory/inventory.service.js';
import { KnowledgeService } from '../../application/knowledge/knowledge.service.js';
import { SAMPLE_DOCUMENTS, SAMPLE_PRODUCTS } from '../../application/knowledge/sample-data.js';
import { SampleDataService } from '../../application/knowledge/sample.service.js';
import type { Company, Membership } from '../../domain/index.js';
import { ConflictError } from '../../shared/errors/index.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import { createLogger } from '../logger/logger.js';
import { createDatabase, type Database } from './database.js';
import {
  PrismaInventoryLedger,
  PrismaProductRepository,
  PrismaStockMovementRepository,
} from './repositories/inventory.repository.js';
import { PrismaKnowledgeDocumentRepository } from './repositories/knowledge-document.repository.js';
import { PrismaMembershipRepository } from './repositories/membership.repository.js';

const config = loadIntegrationConfig();
const HASH = 'scrypt$1024$8$1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA==';

let database: Database;
let tenants: TestTenants;
let documents: PrismaKnowledgeDocumentRepository;
let products: PrismaProductRepository;
let knowledge: KnowledgeService;
let inventory: InventoryService;
let sample: SampleDataService;
let memberships: PrismaMembershipRepository;

before(() => {
  database = createDatabase(config, createLogger(config));
  tenants = new TestTenants(database.prisma);
  documents = new PrismaKnowledgeDocumentRepository(database.prisma);
  products = new PrismaProductRepository(database.prisma);
  knowledge = new KnowledgeService(documents);
  inventory = new InventoryService({
    products,
    movements: new PrismaStockMovementRepository(database.prisma),
    ledger: new PrismaInventoryLedger(database.prisma),
  });
  sample = new SampleDataService({ documents, products, knowledge, inventory });
  memberships = new PrismaMembershipRepository(database.prisma);
});

after(async () => {
  try {
    await tenants.cleanup();
  } finally {
    await database.close();
  }
});

async function newCompany(label: string): Promise<{ company: Company; owner: Membership }> {
  const company = await tenants.createCompany(label);
  const owner = await memberships.create(company.id, {
    email: `${label}-${randomBytes(4).toString('hex')}@exemplo.test`,
    passwordHash: HASH,
    role: 'OWNER',
  });
  return { company, owner };
}

describe('dados de exemplo (E3)', () => {
  it('empresa vazia carrega 2 documentos e 8 produtos (um sem estoque, um abaixo do alerta); repetir não duplica', async () => {
    const { company, owner } = await newCompany('smp-a');
    const first = await sample.load(company.id, owner.id);
    assert.equal(first.created, true);
    const docs = (await documents.list(company.id)).items;
    assert.equal(docs.length, SAMPLE_DOCUMENTS.length);
    assert.ok(docs.every((doc) => doc.isSample));
    const items = (await products.list(company.id)).items;
    assert.equal(items.length, SAMPLE_PRODUCTS.length);
    assert.ok(items.every((item) => item.isSample && item.sku.startsWith('EX-')));
    assert.ok(items.some((item) => item.quantity === 0));
    assert.ok(
      items.some(
        (item) =>
          item.quantity > 0 &&
          item.lowStockThreshold > 0 &&
          item.quantity <= item.lowStockThreshold,
      ),
    );
    const second = await sample.load(company.id, owner.id);
    assert.equal(second.created, false);
    assert.equal((await documents.list(company.id)).items.length, SAMPLE_DOCUMENTS.length);
    assert.equal(await products.count(company.id), SAMPLE_PRODUCTS.length);
  });

  it('empresa com documento ou produto real recusa com SAMPLE_REQUIRES_EMPTY, sem criar nada', async () => {
    const withDoc = await newCompany('smp-doc');
    await knowledge.create(withDoc.company.id, withDoc.owner.id, {
      title: 'Meu documento',
      content: 'texto real',
    });
    await assert.rejects(
      sample.load(withDoc.company.id, withDoc.owner.id),
      (error: unknown) => error instanceof ConflictError && error.code === 'SAMPLE_REQUIRES_EMPTY',
    );
    assert.equal(await products.count(withDoc.company.id), 0);
    const withProduct = await newCompany('smp-prod');
    await inventory.create(withProduct.company.id, withProduct.owner.id, {
      sku: 'REAL-1',
      name: 'Produto real',
      priceCents: 100,
      quantity: 1,
    });
    await assert.rejects(
      sample.load(withProduct.company.id, withProduct.owner.id),
      (error: unknown) => error instanceof ConflictError && error.code === 'SAMPLE_REQUIRES_EMPTY',
    );
    assert.equal(await documents.countDocuments(withProduct.company.id), 0);
  });

  it('remover apaga só os documentos de exemplo e desativa só os produtos de exemplo; a outra empresa não é tocada', async () => {
    const mine = await newCompany('smp-rm');
    const other = await newCompany('smp-other');
    await sample.load(mine.company.id, mine.owner.id);
    await sample.load(other.company.id, other.owner.id);
    const removed = await sample.remove(mine.company.id);
    assert.deepEqual(removed, {
      documents: SAMPLE_DOCUMENTS.length,
      products: SAMPLE_PRODUCTS.length,
    });
    assert.equal(await documents.countDocuments(mine.company.id), 0);
    const mineProducts = (await products.list(mine.company.id)).items;
    assert.equal(mineProducts.length, SAMPLE_PRODUCTS.length);
    assert.ok(mineProducts.every((item) => !item.active));
    // A outra empresa continua com tudo.
    assert.equal(await documents.countDocuments(other.company.id), SAMPLE_DOCUMENTS.length);
    assert.ok((await products.list(other.company.id)).items.every((item) => item.active));
  });

  it('carregar de novo depois de remover reativa os produtos e restaura preço e quantidade', async () => {
    const { company, owner } = await newCompany('smp-restore');
    await sample.load(company.id, owner.id);
    const [camiseta] = (await products.list(company.id, { search: 'camiseta azul' })).items;
    assert.ok(camiseta !== undefined);
    await inventory.update(company.id, camiseta.id, { priceCents: 1, name: 'Editada' });
    await inventory.adjust(company.id, owner.id, camiseta.id, { delta: -10, reason: 'EXIT' });
    await sample.remove(company.id);
    const again = await sample.load(company.id, owner.id);
    assert.equal(again.created, true); // os documentos voltaram
    const restored = await products.findById(company.id, camiseta.id);
    const original = SAMPLE_PRODUCTS.find((entry) => entry.sku === 'EX-CAM-AZ');
    assert.equal(restored.active, true);
    assert.equal(restored.priceCents, original?.priceCents);
    assert.equal(restored.name, original?.name);
    assert.equal(restored.quantity, original?.quantity);
    assert.equal(await products.count(company.id), SAMPLE_PRODUCTS.length);
  });
});
