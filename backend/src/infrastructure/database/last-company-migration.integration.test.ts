import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';

// Spec 029 (E2): a migration aditiva aplica sobre o schema anterior sem perder dado, deixa a coluna nula nas
// contas existentes e a FK zera a dica quando a empresa some. Roda num schema temporário dentro de uma
// transação que sempre sofre rollback: nada compartilhado é alterado.
const config = loadIntegrationConfig();

test('migration da 029 acrescenta accounts.last_company_id sem perder dado e com ON DELETE SET NULL', async () => {
  const sql = await readFile(
    new URL(
      '../../../prisma/migrations/20261105200000_accounts_last_company/migration.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const schema = `soprei_migration_${randomUUID().replaceAll('-', '')}`;
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  const accountId = randomUUID();
  const companyId = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    await client.query('CREATE TABLE companies (id uuid PRIMARY KEY)');
    await client.query('CREATE TABLE accounts (id uuid PRIMARY KEY, email text NOT NULL)');
    await client.query('INSERT INTO companies (id) VALUES ($1)', [companyId]);
    await client.query("INSERT INTO accounts (id, email) VALUES ($1, 'a@x.test')", [accountId]);

    await client.query(sql);

    const before = await client.query<{ last_company_id: string | null }>(
      'SELECT last_company_id FROM accounts WHERE id = $1',
      [accountId],
    );
    assert.equal(before.rows[0]?.last_company_id, null);
    // A FK recusa uma empresa que não existe.
    await client.query('SAVEPOINT attempt');
    await assert.rejects(
      client.query('UPDATE accounts SET last_company_id = $1 WHERE id = $2', [
        randomUUID(),
        accountId,
      ]),
    );
    await client.query('ROLLBACK TO SAVEPOINT attempt');
    await client.query('UPDATE accounts SET last_company_id = $1 WHERE id = $2', [
      companyId,
      accountId,
    ]);
    await client.query('DELETE FROM companies WHERE id = $1', [companyId]);
    const after = await client.query<{ last_company_id: string | null; email: string }>(
      'SELECT last_company_id, email FROM accounts WHERE id = $1',
      [accountId],
    );
    const row = after.rows[0];
    assert.ok(row);
    assert.equal(row.last_company_id, null);
    assert.equal(row.email, 'a@x.test');
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
