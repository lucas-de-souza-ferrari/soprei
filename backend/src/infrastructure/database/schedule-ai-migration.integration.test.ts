import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';

// Spec 028 (E2): a migration aditiva acrescenta as duas colunas (padrão desligado) com o CHECK e os dois índices
// parciais, sem perder dado. Roda num schema temporário dentro de uma transação que sempre sofre rollback.
const config = loadIntegrationConfig();

test('migration da 028: colunas desligadas por padrão, CHECK e índices parciais, sem perder dado', async () => {
  const sql = await readFile(
    new URL(
      '../../../prisma/migrations/20261106100000_schedule_ai_booking/migration.sql',
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
    await client.query(
      'CREATE TABLE schedule_settings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, timezone text NOT NULL)',
    );
    await client.query(
      'CREATE TABLE appointments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, contact_ref text, status text NOT NULL, starts_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now())',
    );
    await client.query("INSERT INTO schedule_settings (company_id, timezone) VALUES ($1, 'UTC')", [
      companyId,
    ]);

    await client.query(sql);

    // A linha existente fica com a IA desligada (nenhuma empresa muda de comportamento).
    const row = await client.query<{ ai_booking_enabled: boolean; ai_auto_confirm: boolean }>(
      'SELECT ai_booking_enabled, ai_auto_confirm FROM schedule_settings WHERE company_id = $1',
      [companyId],
    );
    assert.deepEqual(row.rows[0], { ai_booking_enabled: false, ai_auto_confirm: false });

    // O CHECK: confirmar automaticamente exige a IA ligada.
    await client.query('SAVEPOINT attempt');
    await assert.rejects(
      client.query('UPDATE schedule_settings SET ai_auto_confirm = true WHERE company_id = $1', [
        companyId,
      ]),
    );
    await client.query('ROLLBACK TO SAVEPOINT attempt');
    await client.query(
      'UPDATE schedule_settings SET ai_booking_enabled = true, ai_auto_confirm = true WHERE company_id = $1',
      [companyId],
    );

    // Os dois índices parciais existem e têm o predicado esperado.
    const indexes = await client.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = $1 AND tablename = 'appointments' ORDER BY indexname`,
      [schema],
    );
    const names = indexes.rows.map((item) => item.indexname);
    assert.ok(names.includes('appointments_contact_active_idx'));
    assert.ok(names.includes('appointments_contact_created_idx'));
    const active = indexes.rows.find(
      (item) => item.indexname === 'appointments_contact_active_idx',
    );
    assert.match(active?.indexdef ?? '', /WHERE .*contact_ref IS NOT NULL.*status/s);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
