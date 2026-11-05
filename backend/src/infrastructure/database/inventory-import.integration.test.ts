import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { InventoryService } from '../../application/inventory/inventory.service.js';
import type { Company, Membership } from '../../domain/index.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import { createLogger } from '../logger/logger.js';
import { createDatabase, type Database } from './database.js';
import {
  PrismaInventoryLedger,
  PrismaProductRepository,
  PrismaStockMovementRepository,
} from './repositories/inventory.repository.js';
import { PrismaMembershipRepository } from './repositories/membership.repository.js';

const config = loadIntegrationConfig();
const HASH = 'scrypt$1024$8$1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA==';

let database: Database;
let tenants: TestTenants;
let service: InventoryService;
let products: PrismaProductRepository;
let company: Company;
let owner: Membership;
let sql: pg.Client;

before(async () => {
  database = createDatabase(config, createLogger(config));
  tenants = new TestTenants(database.prisma);
  products = new PrismaProductRepository(database.prisma);
  service = new InventoryService({
    products,
    movements: new PrismaStockMovementRepository(database.prisma),
    ledger: new PrismaInventoryLedger(database.prisma),
  });
  company = await tenants.createCompany('imp');
  owner = await new PrismaMembershipRepository(database.prisma).create(company.id, {
    email: `imp-${randomBytes(4).toString('hex')}@exemplo.test`,
    passwordHash: HASH,
    role: 'OWNER',
  });
  sql = new pg.Client({ connectionString: config.DATABASE_URL });
  await sql.connect();
});

after(async () => {
  try {
    await sql.end();
    await tenants.cleanup();
  } finally {
    await database.close();
  }
});

const row = (sku: string, quantity = 3) => ({
  sku,
  name: `Produto ${sku}`,
  description: '',
  priceCents: 1000,
  quantity,
});

describe('importação de produtos (E4)', () => {
  it('200 linhas criam 200 produtos, cada um com o movimento IMPORT', async () => {
    const rows = Array.from({ length: 200 }, (_, index) => row(`IMP-${String(index)}`, index + 1));
    const result = await service.importRows(company.id, owner.id, rows);
    assert.deepEqual(result, { created: 200, skipped: [] });
    assert.equal(await products.count(company.id), 200);
    const movements = await sql.query<{ reason: string; count: string }>(
      `SELECT reason::text AS reason, count(*)::text AS count FROM stock_movements WHERE company_id = $1 GROUP BY reason`,
      [company.id],
    );
    assert.deepEqual(movements.rows, [{ reason: 'IMPORT', count: '200' }]);
  });

  it('SKU repetido na planilha ou já existente é ignorado com motivo fixo, sem alterar o existente; linha inválida não derruba as demais', async () => {
    const before = await products.findById(
      company.id,
      (await products.list(company.id, { search: 'imp-7' })).items[0]?.id ?? '',
    );
    const result = await service.importRows(company.id, owner.id, [
      row('NOVO-1'),
      row('novo-1'), // repetido na planilha (normalizado)
      row('IMP-7', 999), // já existe
      { sku: 'RUIM', name: '', priceCents: 1, quantity: 1 },
      { sku: 'RUIM2', name: 'x', priceCents: -5, quantity: 1 },
      'não é objeto',
      row('NOVO-2'),
    ]);
    assert.equal(result.created, 2);
    assert.deepEqual(result.skipped, [
      { row: 2, reason: 'duplicate_in_file' },
      { row: 3, reason: 'sku_exists' },
      { row: 4, reason: 'invalid' },
      { row: 5, reason: 'invalid' },
      { row: 6, reason: 'invalid' },
    ]);
    const after = await products.findById(company.id, before.id);
    assert.equal(after.quantity, before.quantity);
    assert.equal(after.name, before.name);
  });
});
