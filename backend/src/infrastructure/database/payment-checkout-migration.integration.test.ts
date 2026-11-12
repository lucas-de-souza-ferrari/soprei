import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';

// Spec 031 (E3): a migration só acrescenta três colunas anuláveis em payment_orders e não muda nenhum dado.
// Roda num schema temporário dentro de uma transação que sempre sofre rollback.
const config = loadIntegrationConfig();
const MIGRATION = new URL(
  '../../../prisma/migrations/20261109200000_payment_checkout/migration.sql',
  import.meta.url,
);

test('a migration do checkout só acrescenta colunas: nenhum DROP, DELETE, TRUNCATE, RENAME nem ALTER COLUMN', async () => {
  const sql = await readFile(MIGRATION, 'utf8');
  const code = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  for (const forbidden of [/\bDROP\b/i, /\bDELETE\s+FROM\b/i, /\bTRUNCATE\b/i, /\bRENAME\b/i]) {
    assert.doesNotMatch(code, forbidden);
  }
  assert.doesNotMatch(code, /ALTER COLUMN/i);
});

test('a migration da revisão cria só índices únicos parciais da referência e da fatura', async () => {
  const sql = await readFile(
    new URL(
      '../../../prisma/migrations/20261109210000_payment_reference_unique/migration.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const code = sql
    .split(String.fromCharCode(10))
    .filter((line) => !line.trim().startsWith('--'))
    .join(String.fromCharCode(10));
  assert.doesNotMatch(code, /DROP|DELETE|TRUNCATE|RENAME|ALTER COLUMN/i);
  assert.equal((code.match(/CREATE UNIQUE INDEX/g) ?? []).length, 2);
  assert.equal((code.match(/WHERE "provider_/g) ?? []).length, 2);
});

test('aplica sobre pedidos existentes sem perder dado: as três colunas nascem nulas', async () => {
  const sql = await readFile(MIGRATION, 'utf8');
  const schema = `soprei_migration_${randomUUID().replaceAll('-', '')}`;
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  const orderId = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    await client.query(
      'CREATE TABLE payment_orders (id uuid PRIMARY KEY, amount_cents integer NOT NULL, provider_transaction_ref text)',
    );
    await client.query(
      "INSERT INTO payment_orders (id, amount_cents, provider_transaction_ref) VALUES ($1, 8800, 'tx-antiga')",
      [orderId],
    );
    await client.query(sql);
    const row = await client.query<{
      amount_cents: number;
      provider_transaction_ref: string;
      provider_slug: string | null;
      capture_method: string | null;
      last_checked_at: Date | null;
    }>('SELECT * FROM payment_orders WHERE id = $1', [orderId]);
    assert.equal(row.rows[0]?.amount_cents, 8_800);
    assert.equal(row.rows[0].provider_transaction_ref, 'tx-antiga');
    assert.equal(row.rows[0].provider_slug, null);
    assert.equal(row.rows[0].capture_method, null);
    assert.equal(row.rows[0].last_checked_at, null);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
