import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { MODEL_SCOPES } from './extensions/tenant-scope.js';

// Spec 026 (E2): a migration aplica sobre o schema anterior, cria o enum, as duas tabelas, o índice GIN
// de expressão, as chaves estrangeiras compostas e os CHECKs. Roda num schema temporário dentro de uma
// transação que sempre sofre rollback: nada compartilhado é alterado.
const config = loadIntegrationConfig();

test('migration da 026 (E2) aplica sobre o schema anterior e impõe índice, FKs compostas e CHECKs', async () => {
  const sql = await readFile(
    new URL(
      '../../../prisma/migrations/20261104220000_inventory_products/migration.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const schema = `soprei_migration_${randomUUID().replaceAll('-', '')}`;
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  const companyA = randomUUID();
  const companyB = randomUUID();
  const memberA = randomUUID();
  const memberB = randomUUID();
  const refused = async (statement: string, values: unknown[] = []): Promise<boolean> => {
    await client.query('SAVEPOINT attempt');
    try {
      await client.query(statement, values);
      await client.query('RELEASE SAVEPOINT attempt');
      return false;
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT attempt');
      return true;
    }
  };
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    await client.query('CREATE TABLE companies (id uuid PRIMARY KEY)');
    await client.query(`CREATE TABLE memberships (
      id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), email text NOT NULL)`);
    await client.query(
      'CREATE UNIQUE INDEX memberships_id_company_id_key ON memberships (id, company_id)',
    );
    await client.query('INSERT INTO companies (id) VALUES ($1), ($2)', [companyA, companyB]);
    await client.query(
      `INSERT INTO memberships (id, company_id, email) VALUES ($1, $3, 'a@x.test'), ($2, $4, 'b@x.test')`,
      [memberA, memberB, companyA, companyB],
    );

    await client.query(sql);

    const gin = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'products_search_idx'`,
      [schema],
    );
    assert.match(
      gin.rows[0]?.indexdef ?? '',
      /USING gin \(to_tsvector\('portuguese'::regconfig, search_text\)\)/,
    );
    const reasons = await client.query<{ enumlabel: string }>(
      `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'stock_reason' AND t.typnamespace = $1::regnamespace ORDER BY e.enumsortorder`,
      [schema],
    );
    assert.deepEqual(
      reasons.rows.map((row) => row.enumlabel),
      ['INITIAL', 'ENTRY', 'EXIT', 'LOSS', 'COUNT_CORRECTION', 'IMPORT'],
    );

    const productId = randomUUID();
    const insertProduct = (id: string, company: string, code: string, quantity = 5) =>
      client.query(
        `INSERT INTO products (id, company_id, sku, name, price_cents, quantity, search_text, updated_at)
         VALUES ($1, $2, $3, 'Produto', 100, $4, 'produto', now())`,
        [id, company, code, quantity],
      );
    await insertProduct(productId, companyA, 'SKU-1');
    // O mesmo SKU em outra empresa é aceito; na mesma empresa, não.
    await insertProduct(randomUUID(), companyB, 'SKU-1');
    await client.query('SAVEPOINT dup');
    await assert.rejects(
      insertProduct(randomUUID(), companyA, 'SKU-1'),
      /unicidade|unique|duplicate/i,
    );
    await client.query('ROLLBACK TO SAVEPOINT dup');

    const insertMovement = (company: string, product: string, member: string, delta: number) =>
      client.query(
        `INSERT INTO stock_movements (id, company_id, product_id, delta, quantity_after, reason, created_by_membership_id)
         VALUES ($1, $2, $3, $4, 5, 'ENTRY', $5)`,
        [randomUUID(), company, product, delta, member],
      );
    await insertMovement(companyA, productId, memberA, 1);
    // FKs compostas: movimento de um produto de outra empresa e autor de outra empresa são recusados.
    await client.query('SAVEPOINT fk1');
    await assert.rejects(
      insertMovement(companyB, productId, memberB, 1),
      /foreign key|chave estrangeira/i,
    );
    await client.query('ROLLBACK TO SAVEPOINT fk1');
    await client.query('SAVEPOINT fk2');
    await assert.rejects(
      insertMovement(companyA, productId, memberB, 1),
      /foreign key|chave estrangeira/i,
    );
    await client.query('ROLLBACK TO SAVEPOINT fk2');
    // CHECKs.
    await client.query('SAVEPOINT chk');
    await assert.rejects(insertMovement(companyA, productId, memberA, 0), /check|restrição/i);
    await client.query('ROLLBACK TO SAVEPOINT chk');
    assert.equal(
      await refused(`UPDATE products SET quantity = -1 WHERE id = $1`, [productId]),
      true,
    );
    assert.equal(
      await refused(`UPDATE products SET quantity = 1000001 WHERE id = $1`, [productId]),
      true,
    );
    assert.equal(
      await refused(`UPDATE products SET sku = 'minúsculo' WHERE id = $1`, [productId]),
      true,
    );
    assert.equal(
      await refused(`UPDATE products SET price_cents = -1 WHERE id = $1`, [productId]),
      true,
    );
    // Produto com movimento não pode ser apagado (RESTRICT): remover é desativar.
    assert.equal(await refused(`DELETE FROM products WHERE id = $1`, [productId]), true);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});

test('os models novos da 026 (E2) estão classificados como tenant', () => {
  assert.equal(MODEL_SCOPES.Product, 'tenant');
  assert.equal(MODEL_SCOPES.StockMovement, 'tenant');
});
