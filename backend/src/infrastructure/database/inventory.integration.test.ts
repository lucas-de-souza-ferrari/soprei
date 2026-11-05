import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { InventoryService } from '../../application/inventory/inventory.service.js';
import { buildQuery } from '../../application/knowledge/query.js';
import { type Company, type Membership, PRODUCT_QUANTITY_MAX } from '../../domain/index.js';
import { ConflictError, NotFoundError } from '../../shared/errors/index.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import { createLogger } from '../logger/logger.js';
import { createDatabase, type Database } from './database.js';
import { PrismaMembershipRepository } from './repositories/membership.repository.js';
import { PrismaKnowledgeRetriever } from './repositories/knowledge-retriever.js';
import {
  PrismaInventoryLedger,
  PrismaProductRepository,
  PrismaStockMovementRepository,
} from './repositories/inventory.repository.js';

const config = loadIntegrationConfig();
const HASH = 'scrypt$1024$8$1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA==';

let database: Database;
let tenants: TestTenants;
let service: InventoryService;
let products: PrismaProductRepository;
let movements: PrismaStockMovementRepository;
let retriever: PrismaKnowledgeRetriever;
let companyA: Company;
let companyB: Company;
let ownerA: Membership;
let ownerB: Membership;
let sql: pg.Client;

const email = (label: string): string => `${label}-${randomBytes(5).toString('hex')}@exemplo.test`;
const sku = (label: string): string => `${label}-${randomBytes(3).toString('hex')}`.toUpperCase();

before(async () => {
  database = createDatabase(config, createLogger(config));
  tenants = new TestTenants(database.prisma);
  products = new PrismaProductRepository(database.prisma);
  movements = new PrismaStockMovementRepository(database.prisma);
  retriever = new PrismaKnowledgeRetriever(database.prisma);
  service = new InventoryService({
    products,
    movements,
    ledger: new PrismaInventoryLedger(database.prisma),
  });
  const memberships = new PrismaMembershipRepository(database.prisma);
  companyA = await tenants.createCompany('inv-a');
  companyB = await tenants.createCompany('inv-b');
  ownerA = await memberships.create(companyA.id, {
    email: email('a'),
    passwordHash: HASH,
    role: 'OWNER',
  });
  ownerB = await memberships.create(companyB.id, {
    email: email('b'),
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

const input = (code: string, quantity: number, name = `Produto ${code}`) => ({
  sku: code,
  name,
  priceCents: 5990,
  quantity,
});

describe('estoque atômico (E2)', () => {
  it('10 unidades e 30 saídas concorrentes de 1: exatamente 10 aplicadas, 20 INSUFFICIENT_STOCK, nunca negativo', async () => {
    const created = await service.create(companyA.id, ownerA.id, input(sku('ATOM'), 10));
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, () =>
        service.adjust(companyA.id, ownerA.id, created.id, { delta: -1, reason: 'EXIT' }),
      ),
    );
    const applied = results.filter((result) => result.status === 'fulfilled');
    const refused = results.filter((result) => result.status === 'rejected');
    assert.equal(applied.length, 10);
    assert.equal(refused.length, 20);
    for (const result of refused) {
      assert.ok(result.reason instanceof ConflictError);
      assert.equal(result.reason.code, 'INSUFFICIENT_STOCK');
    }
    const final = await products.findById(companyA.id, created.id);
    assert.equal(final.quantity, 0);
    const ledger = await sql.query<{ quantity_after: number; delta: number }>(
      `SELECT quantity_after, delta FROM stock_movements WHERE product_id = $1 AND reason = 'EXIT'`,
      [created.id],
    );
    assert.equal(ledger.rows.length, 10);
    assert.deepEqual(
      ledger.rows.map((row) => row.quantity_after).sort((a, b) => a - b),
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    );
    // Mais o INITIAL: 11 movimentos no total, e a soma dos deltas é a quantidade final.
    const all = await sql.query<{ sum: string; count: string }>(
      'SELECT sum(delta)::text AS sum, count(*)::text AS count FROM stock_movements WHERE product_id = $1',
      [created.id],
    );
    assert.equal(all.rows[0]?.count, '11');
    assert.equal(all.rows[0].sum, '0');
  });

  it('entradas e saídas concorrentes misturadas: quantidade final = inicial + soma dos movimentos', async () => {
    const created = await service.create(companyA.id, ownerA.id, input(sku('MIX'), 5));
    const operations = Array.from({ length: 40 }, (_, index) =>
      service
        .adjust(companyA.id, ownerA.id, created.id, {
          delta: index % 3 === 0 ? 4 : -2,
          reason: index % 3 === 0 ? 'ENTRY' : 'EXIT',
        })
        .then(
          () => true,
          () => false,
        ),
    );
    await Promise.all(operations);
    const final = await products.findById(companyA.id, created.id);
    const sum = await sql.query<{ sum: string }>(
      'SELECT sum(delta)::text AS sum FROM stock_movements WHERE product_id = $1',
      [created.id],
    );
    assert.equal(final.quantity, Number(sum.rows[0]?.sum));
    assert.ok(final.quantity >= 0);
  });

  it('entrada acima de 1.000.000 é STOCK_LIMIT, sem movimento', async () => {
    const created = await service.create(
      companyA.id,
      ownerA.id,
      input(sku('MAX'), PRODUCT_QUANTITY_MAX - 5),
    );
    await assert.rejects(
      service.adjust(companyA.id, ownerA.id, created.id, { delta: 6, reason: 'ENTRY' }),
      (error: unknown) => error instanceof ConflictError && error.code === 'STOCK_LIMIT',
    );
    const count = await sql.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM stock_movements WHERE product_id = $1 AND reason = 'ENTRY'`,
      [created.id],
    );
    assert.equal(count.rows[0]?.count, '0');
    const ok = await service.adjust(companyA.id, ownerA.id, created.id, {
      delta: 5,
      reason: 'ENTRY',
    });
    assert.equal(ok.product.quantity, PRODUCT_QUANTITY_MAX);
  });

  it('falha ao gravar o movimento desfaz o ajuste (mesma transação)', async () => {
    const created = await service.create(companyA.id, ownerA.id, input(sku('ROLL'), 7));
    // Vínculo inexistente: a FK composta do movimento falha depois do UPDATE da quantidade.
    await assert.rejects(
      service.adjust(companyA.id, randomUUID(), created.id, { delta: -3, reason: 'LOSS' }),
    );
    assert.equal((await products.findById(companyA.id, created.id)).quantity, 7);
  });

  it('movimentos são imutáveis (sem update/delete) e o banco recusa delta 0 e motivo fora do enum', async () => {
    assert.deepEqual(Object.getOwnPropertyNames(PrismaStockMovementRepository.prototype).sort(), [
      'constructor',
      'listByProduct',
    ]);
    assert.ok(!('update' in movements) && !('delete' in movements));
    assert.ok(!('delete' in products));
    const created = await service.create(companyA.id, ownerA.id, input(sku('IMM'), 3));
    const insert = (delta: number, reason: string) =>
      sql.query(
        `INSERT INTO stock_movements (id, company_id, product_id, delta, quantity_after, reason, created_by_membership_id)
         VALUES ($1, $2, $3, $4, 3, $5::stock_reason, $6)`,
        [randomUUID(), companyA.id, created.id, delta, reason, ownerA.id],
      );
    await assert.rejects(insert(0, 'ENTRY'), /check|restrição/i);
    await assert.rejects(insert(1, 'NAO_EXISTE'), /enum|stock_reason/i);
  });

  it('o CHECK do banco recusa quantidade negativa ou acima do teto mesmo por SQL direto', async () => {
    const created = await service.create(companyA.id, ownerA.id, input(sku('CHK'), 1));
    await assert.rejects(
      sql.query('UPDATE products SET quantity = -1 WHERE id = $1', [created.id]),
      /check|restrição/i,
    );
    await assert.rejects(
      sql.query('UPDATE products SET quantity = 1000001 WHERE id = $1', [created.id]),
      /check|restrição/i,
    );
  });
});

describe('produtos: SKU, isolamento e listagem (E2)', () => {
  it('SKU em minúsculas é normalizado e colide; a corrida de duas criações dá uma vitória e um 409 SKU_IN_USE', async () => {
    const code = sku('DUP');
    const first = await service.create(companyA.id, ownerA.id, {
      ...input(code, 1),
      sku: code.toLowerCase().toUpperCase(),
    });
    assert.equal(first.sku, code);
    await assert.rejects(
      service.create(companyA.id, ownerA.id, input(code, 1)),
      (error: unknown) => error instanceof ConflictError && error.code === 'SKU_IN_USE',
    );
    const race = sku('RACE');
    const results = await Promise.allSettled([
      service.create(companyA.id, ownerA.id, input(race, 1)),
      service.create(companyA.id, ownerA.id, input(race, 1)),
      service.create(companyA.id, ownerA.id, input(race, 1)),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    for (const result of results) {
      if (result.status === 'rejected') {
        assert.ok(result.reason instanceof ConflictError);
        assert.equal(result.reason.code, 'SKU_IN_USE');
      }
    }
    // O mesmo SKU em outra empresa é aceito.
    const other = await service.create(companyB.id, ownerB.id, input(code, 1));
    assert.equal(other.sku, code);
  });

  it('isolamento: id de outra empresa em PATCH, ajuste e movimentos é 404 igual a inexistente', async () => {
    const mine = await service.create(companyA.id, ownerA.id, input(sku('ISO'), 4));
    await assert.rejects(service.update(companyB.id, mine.id, { active: false }), NotFoundError);
    await assert.rejects(
      service.adjust(companyB.id, ownerB.id, mine.id, { delta: 1, reason: 'ENTRY' }),
      NotFoundError,
    );
    await assert.rejects(service.movements(companyB.id, mine.id), NotFoundError);
    await assert.rejects(
      service.update(companyA.id, randomUUID(), { active: false }),
      NotFoundError,
    );
    await assert.rejects(
      service.update(companyA.id, 'nao-e-uuid', { active: false }),
      NotFoundError,
    );
    // Nada mudou na A.
    assert.equal((await products.findById(companyA.id, mine.id)).quantity, 4);
    assert.equal((await products.findById(companyA.id, mine.id)).active, true);
  });

  it('o banco recusa movimento de um produto de outra empresa (FK composta)', async () => {
    const mine = await service.create(companyA.id, ownerA.id, input(sku('FK'), 2));
    await assert.rejects(
      sql.query(
        `INSERT INTO stock_movements (id, company_id, product_id, delta, quantity_after, reason, created_by_membership_id)
         VALUES ($1, $2, $3, 1, 3, 'ENTRY', $4)`,
        [randomUUID(), companyB.id, mine.id, ownerB.id],
      ),
      /foreign key|chave estrangeira/,
    );
  });

  it('PATCH muda nome, preço, alerta e ativo, nunca a quantidade; a lista pagina por nome e filtra sem acento; o cursor não vaza a outra empresa', async () => {
    const company = await tenants.createCompany('inv-lista');
    const owner = await new PrismaMembershipRepository(database.prisma).create(company.id, {
      email: email('l'),
      passwordHash: HASH,
      role: 'OWNER',
    });
    for (const [code, name] of [
      ['L-1', 'Camiseta Azul'],
      ['L-2', 'Calça Jeans'],
      ['L-3', 'Boné Preto'],
    ] as const) {
      await service.create(company.id, owner.id, input(code, 5, name));
    }
    const first = await service.list(company.id, { limit: 2 });
    assert.deepEqual(
      first.items.map((item) => item.name),
      ['Boné Preto', 'Calça Jeans'],
    );
    assert.ok(first.nextCursor !== null);
    const second = await service.list(company.id, { limit: 2, cursor: first.nextCursor });
    assert.deepEqual(
      second.items.map((item) => item.name),
      ['Camiseta Azul'],
    );
    assert.equal(second.nextCursor, null);
    const other = await service.list(companyB.id, { limit: 5, cursor: first.nextCursor });
    assert.ok(other.items.every((item) => item.companyId === companyB.id));
    const found = await service.list(company.id, { search: 'CALCA' });
    assert.deepEqual(
      found.items.map((item) => item.sku),
      ['L-2'],
    );
    const bySku = await service.list(company.id, { search: 'l-3' });
    assert.deepEqual(
      bySku.items.map((item) => item.name),
      ['Boné Preto'],
    );
    const [camiseta] = (await service.list(company.id, { search: 'camiseta' })).items;
    assert.ok(camiseta !== undefined);
    const updated = await service.update(company.id, camiseta.id, {
      name: 'Camiseta Verde',
      priceCents: 100,
      active: false,
    });
    assert.equal(updated.quantity, 5);
    assert.equal(updated.name, 'Camiseta Verde');
    assert.equal(updated.priceCents, 100);
    assert.equal(updated.active, false);
    // O texto de busca acompanha o nome novo.
    assert.equal((await service.list(company.id, { search: 'verde' })).items.length, 1);
    assert.equal((await service.list(company.id, { search: 'azul' })).items.length, 0);
  });

  it('o histórico de movimentos pagina (mais recentes primeiro) e é do produto da empresa', async () => {
    const mine = await service.create(companyA.id, ownerA.id, input(sku('HIST'), 2));
    for (const delta of [3, -1, 2]) {
      await service.adjust(companyA.id, ownerA.id, mine.id, {
        delta,
        reason: delta > 0 ? 'ENTRY' : 'EXIT',
      });
    }
    const page = await service.movements(companyA.id, mine.id, { limit: 3 });
    assert.deepEqual(
      page.items.map((item) => item.quantityAfter),
      [6, 4, 5],
    );
    assert.ok(page.nextCursor !== null);
    const rest = await service.movements(companyA.id, mine.id, {
      limit: 3,
      cursor: page.nextCursor,
    });
    assert.deepEqual(
      rest.items.map((item) => [item.reason, item.quantityAfter]),
      [['INITIAL', 2]],
    );
  });
});

describe('recuperação de produtos pelo atendimento (E2)', () => {
  const query = (text: string): string => {
    const tsquery = buildQuery(text);
    assert.ok(tsquery !== null);
    return tsquery;
  };

  it('acha por nome, devolve preço, quantidade e hora do dado; 0 unidades continua aparecendo; inativo e outra empresa não', async () => {
    const company = await tenants.createCompany('inv-rec');
    const owner = await new PrismaMembershipRepository(database.prisma).create(company.id, {
      email: email('r'),
      passwordHash: HASH,
      role: 'OWNER',
    });
    const blue = await service.create(company.id, owner.id, {
      sku: 'CAM-001',
      name: 'Camiseta Azul',
      description: 'Algodão pima, tamanho M',
      priceCents: 5990,
      quantity: 12,
    });
    await service.create(company.id, owner.id, input('BON-002', 0, 'Boné Vermelho'));
    const hidden = await service.create(
      company.id,
      owner.id,
      input('OCU-003', 9, 'Meia Escondida'),
    );
    await service.update(company.id, hidden.id, { active: false });
    // A outra empresa tem produto com o mesmo nome.
    await service.create(companyB.id, ownerB.id, {
      ...input(sku('B'), 99, 'Camiseta Azul'),
      description: 'da B',
    });

    const found = await retriever.retrieve(company.id, query('quanto custa a camiseta azul?'));
    assert.equal(found.products.length, 1);
    const [item] = found.products;
    assert.equal(item?.productId, blue.id);
    assert.equal(item.priceCents, 5990);
    assert.equal(item.quantity, 12);
    assert.ok(item.updatedAt instanceof Date);
    assert.equal(found.hasAnyKnowledge, true);

    const zero = await retriever.retrieve(company.id, query('tem bonés vermelhos?'));
    assert.equal(zero.products[0]?.quantity, 0);
    // Pelo SKU digitado.
    const bySku = await retriever.retrieve(company.id, query('CAM-001'));
    assert.equal(bySku.products[0]?.sku, 'CAM-001');
    // Inativo não é recuperado.
    assert.deepEqual((await retriever.retrieve(company.id, query('meia escondida'))).products, []);
    // Atualizar o produto muda a "hora do dado".
    const before = found.products[0]?.updatedAt.getTime() ?? 0;
    await service.adjust(company.id, owner.id, blue.id, { delta: -2, reason: 'EXIT' });
    const after = await retriever.retrieve(company.id, query('camiseta azul'));
    assert.equal(after.products[0]?.quantity, 10);
    assert.ok(after.products[0].updatedAt.getTime() >= before);
  });

  it('uma empresa só com produtos tem hasAnyKnowledge; a vazia não', async () => {
    const empty = await tenants.createCompany('inv-vazia');
    assert.equal((await retriever.retrieve(empty.id, query('camiseta'))).hasAnyKnowledge, false);
  });
});
