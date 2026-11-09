import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';

// Spec 031 (E1): a migration aditiva aplica sobre o schema anterior sem perder dado, semeia só o catálogo do
// modo "a empresa paga a Meta" e deixa os CHECKs no banco. Roda num schema temporário dentro de uma
// transação que sempre sofre rollback.
const config = loadIntegrationConfig();
const MIGRATION = new URL(
  '../../../prisma/migrations/20261109100000_plans_subscriptions/migration.sql',
  import.meta.url,
);

test('a migration da 031 só acrescenta: nenhum DROP, DELETE, TRUNCATE, RENAME nem ALTER COLUMN', async () => {
  const sql = await readFile(MIGRATION, 'utf8');
  const code = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  for (const forbidden of [/\bDROP\b/i, /\bDELETE\s+FROM\b/i, /\bTRUNCATE\b/i, /\bRENAME\b/i]) {
    assert.doesNotMatch(code, forbidden);
  }
  assert.doesNotMatch(code, /ALTER COLUMN/i);
  // Só o modo C é semeado: o modo S não existe no catálogo até o dono confirmar a linha de crédito.
  const seeds = code.slice(code.indexOf('INSERT INTO'));
  assert.doesNotMatch(seeds, /SOPREI_PAYS_META/);
});

test('aplica sobre o schema anterior sem perder empresa existente e semeia o catálogo versionado', async () => {
  const sql = await readFile(MIGRATION, 'utf8');
  const schema = `soprei_migration_${randomUUID().replaceAll('-', '')}`;
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  const companyId = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    await client.query('CREATE TABLE accounts (id uuid PRIMARY KEY)');
    await client.query('CREATE TABLE companies (id uuid PRIMARY KEY, name text NOT NULL)');
    await client.query("INSERT INTO companies (id, name) VALUES ($1, 'Empresa')", [companyId]);

    await client.query(sql);

    // Empresa existente intacta, sem assinatura (a adoção é do servidor, só com a cobrança ligada).
    const company = await client.query<{ name: string; subscription_id: string | null }>(
      'SELECT name, subscription_id FROM companies WHERE id = $1',
      [companyId],
    );
    assert.deepEqual(company.rows[0], { name: 'Empresa', subscription_id: null });

    const plans = await client.query<{
      code: string;
      max_companies: number;
      monthly_replies: number;
    }>('SELECT code, max_companies, monthly_replies FROM plans ORDER BY max_companies');
    assert.deepEqual(plans.rows, [
      { code: 'ESSENTIAL', max_companies: 1, monthly_replies: 800 },
      { code: 'PROFESSIONAL', max_companies: 3, monthly_replies: 3200 },
      { code: 'SCALE', max_companies: 10, monthly_replies: 10800 },
    ]);
    const modes = await client.query<{ mode: string; n: string }>(
      'SELECT whatsapp_billing_mode::text AS mode, count(*) AS n FROM plan_prices GROUP BY 1',
    );
    assert.deepEqual(modes.rows, [{ mode: 'CUSTOMER_PAYS_META', n: '6' }]);

    // CHECKs: período invertido, teste sem prazo e contador negativo são recusados pelo banco.
    const account = randomUUID();
    await client.query('INSERT INTO accounts (id) VALUES ($1)', [account]);
    const plan = (
      await client.query<{ id: string }>("SELECT id FROM plans WHERE code = 'ESSENTIAL'")
    ).rows[0];
    const price = (await client.query<{ id: string }>('SELECT id FROM plan_prices LIMIT 1'))
      .rows[0];
    assert.ok(plan !== undefined && price !== undefined);
    const insert = (status: string, start: string, end: string, trial: string | null) =>
      client.query(
        `INSERT INTO subscriptions (id, account_id, plan_id, price_id, cycle, status, current_period_start,
           current_period_end, trial_ends_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'MONTHLY', $4::subscription_status, $5, $6, $7, now())`,
        [account, plan.id, price.id, status, start, end, trial],
      );
    await client.query('SAVEPOINT a');
    await assert.rejects(
      insert('ACTIVE', '2026-12-01', '2026-11-01', null),
      /subscriptions_period_check/,
    );
    await client.query('ROLLBACK TO a');
    await assert.rejects(
      insert('TRIAL', '2026-11-01', '2026-11-08', null),
      /subscriptions_trial_check/,
    );
    await client.query('ROLLBACK TO a');
    await insert('TRIAL', '2026-11-01', '2026-11-08', '2026-11-08');
    // Uma assinatura por conta.
    await client.query('SAVEPOINT b');
    await assert.rejects(
      insert('TRIAL', '2026-11-01', '2026-11-08', '2026-11-08'),
      /subscriptions_account_id_key/,
    );
    await client.query('ROLLBACK TO b');
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
