import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';

// Spec 030: a migration aditiva aplica sobre o schema anterior sem perder dado e deixa a coluna nula nas
// empresas existentes. Roda num schema temporário dentro de uma transação que sempre sofre rollback.
const config = loadIntegrationConfig();

test('migration da 030 acrescenta companies.onboarding_dismissed_at nula, sem perder dado', async () => {
  const sql = await readFile(
    new URL(
      '../../../prisma/migrations/20261106200000_company_onboarding_dismissed/migration.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const schema = `soprei_migration_${randomUUID().replaceAll('-', '')}`;
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  const companyId = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    await client.query('CREATE TABLE companies (id uuid PRIMARY KEY, name text NOT NULL)');
    await client.query("INSERT INTO companies (id, name) VALUES ($1, 'Empresa')", [companyId]);

    await client.query(sql);

    const row = await client.query<{ onboarding_dismissed_at: Date | null; name: string }>(
      'SELECT onboarding_dismissed_at, name FROM companies WHERE id = $1',
      [companyId],
    );
    assert.equal(row.rows[0]?.onboarding_dismissed_at, null);
    assert.equal(row.rows[0].name, 'Empresa');
    const type = await client.query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'companies' AND column_name = 'onboarding_dismissed_at'`,
      [schema],
    );
    assert.deepEqual(type.rows[0], {
      data_type: 'timestamp with time zone',
      is_nullable: 'YES',
    });
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
