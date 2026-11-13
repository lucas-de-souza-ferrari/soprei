import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';

// Spec 040 (E1): a migration do catálogo novo só ACRESCENTA versões (plans e plan_prices são append-only), com
// a versão calculada como máximo + 1 (a produção tem versões extras do Essencial). Roda num schema temporário,
// sobre o schema da 031, dentro de uma transação que sempre sofre rollback.
const config = loadIntegrationConfig();
const BASE = new URL(
  '../../../prisma/migrations/20261109100000_plans_subscriptions/migration.sql',
  import.meta.url,
);
const MIGRATION = new URL(
  '../../../prisma/migrations/20261113100000_catalog_2026_11/migration.sql',
  import.meta.url,
);

/** O catálogo da spec 040 (D1 e D2), em centavos e cotas. */
const EXPECTED = {
  ESSENTIAL: {
    maxCompanies: 1,
    replies: 2_500,
    tokens: 15_000_000,
    MONTHLY: [4_790, 2_900, 1_900],
    ANNUAL: [47_900, 29_000, 19_000],
  },
  PROFESSIONAL: {
    maxCompanies: 3,
    replies: 8_000,
    tokens: 48_000_000,
    MONTHLY: [11_990, 4_900, 3_900],
    ANNUAL: [119_900, 49_000, 39_000],
  },
  SCALE: {
    maxCompanies: 10,
    replies: 30_000,
    tokens: 180_000_000,
    MONTHLY: [34_900, 9_900, 7_900],
    ANNUAL: [349_000, 99_000, 79_000],
  },
} as const;

interface CatalogRow {
  code: keyof typeof EXPECTED;
  version: number;
  max_companies: number;
  monthly_replies: number;
  monthly_tokens: string;
  meta: number;
  cycle: 'MONTHLY' | 'ANNUAL';
  base_cents: number;
  agenda_cents: number;
  stock_cents: number;
  mode: string;
  meta_per_reply: number;
  extra_cents: number;
  extra_replies: number;
}

/**
 * O catálogo vigente em `now` pela MESMA regra de `PrismaBillingRepository.catalog` (sem a flag do modo S):
 * por código, a maior versão ativa de `plans`; nela, por ciclo, o preço de maior versão com valid_from <= now.
 */
const CATALOG_SQL = `
  WITH newest AS (
    SELECT DISTINCT ON (code) * FROM plans WHERE active ORDER BY code, version DESC
  ), prices AS (
    SELECT DISTINCT ON (pp.plan_id, pp.cycle) pp.*
    FROM plan_prices pp
    WHERE pp.valid_from <= $1 AND pp.whatsapp_billing_mode = 'CUSTOMER_PAYS_META'
    ORDER BY pp.plan_id, pp.cycle, pp.version DESC
  )
  SELECT n.code::text AS code, n.version, n.max_companies, n.monthly_replies,
         n.monthly_tokens::text AS monthly_tokens, n.meta_estimate_milli_cents AS meta,
         p.cycle::text AS cycle, p.base_cents, p.agenda_cents, p.stock_cents,
         p.whatsapp_billing_mode::text AS mode, p.meta_per_reply_milli_cents AS meta_per_reply,
         p.extra_pack_cents AS extra_cents, p.extra_pack_replies AS extra_replies
  FROM newest n JOIN prices p ON p.plan_id = n.id
  ORDER BY n.max_companies, p.cycle`;

async function withSchema(run: (client: pg.Client) => Promise<void>): Promise<void> {
  const schema = `soprei_migration_${randomUUID().replaceAll('-', '')}`;
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    await client.query('CREATE TABLE accounts (id uuid PRIMARY KEY)');
    await client.query('CREATE TABLE companies (id uuid PRIMARY KEY, name text NOT NULL)');
    await client.query(await readFile(BASE, 'utf8'));
    await run(client);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
}

async function snapshot(client: pg.Client): Promise<{ plans: string[]; prices: string[] }> {
  const plans = await client.query<{ row: string }>(
    'SELECT row_to_json(p)::text AS row FROM plans p ORDER BY id',
  );
  const prices = await client.query<{ row: string }>(
    'SELECT row_to_json(pp)::text AS row FROM plan_prices pp ORDER BY id',
  );
  return { plans: plans.rows.map((r) => r.row), prices: prices.rows.map((r) => r.row) };
}

function assertNewCatalog(rows: readonly CatalogRow[]): void {
  assert.equal(rows.length, 6, 'três planos com mensal e anual');
  for (const row of rows) {
    const expected = EXPECTED[row.code];
    assert.equal(row.max_companies, expected.maxCompanies, row.code);
    assert.equal(row.monthly_replies, expected.replies, row.code);
    assert.equal(row.monthly_tokens, String(expected.tokens), row.code);
    // Tokens = 6.000 por resposta incluída (D2).
    assert.equal(Number(row.monthly_tokens), row.monthly_replies * 6_000, row.code);
    assert.deepEqual(
      [row.base_cents, row.agenda_cents, row.stock_cents],
      [...expected[row.cycle]],
      `${row.code} ${row.cycle}`,
    );
    assert.equal(row.mode, 'CUSTOMER_PAYS_META');
    // Colunas que não mudam (copiadas da 031).
    assert.equal(row.meta, 3_500);
    assert.equal(row.meta_per_reply, 3_500);
    assert.equal(row.extra_cents, 5_900);
    assert.equal(row.extra_replies, 500);
  }
  // Anual = 10 x mensal, para o plano e para os módulos.
  for (const code of Object.keys(EXPECTED) as (keyof typeof EXPECTED)[]) {
    const monthly = rows.find((row) => row.code === code && row.cycle === 'MONTHLY');
    const annual = rows.find((row) => row.code === code && row.cycle === 'ANNUAL');
    assert.ok(monthly !== undefined && annual !== undefined);
    assert.equal(annual.base_cents, monthly.base_cents * 10, code);
    assert.equal(annual.agenda_cents, monthly.agenda_cents * 10, code);
    assert.equal(annual.stock_cents, monthly.stock_cents * 10, code);
  }
}

test('a migration da 040 só acrescenta: nenhum UPDATE, DELETE, DROP, TRUNCATE, RENAME nem ALTER, e não cria preço do modo S', async () => {
  const sql = await readFile(MIGRATION, 'utf8');
  const code = sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  for (const forbidden of [
    /\bUPDATE\b/i,
    /\bDELETE\b/i,
    /\bDROP\b/i,
    /\bTRUNCATE\b/i,
    /\bRENAME\b/i,
    /\bALTER\b/i,
  ]) {
    assert.doesNotMatch(code, forbidden);
  }
  assert.doesNotMatch(code, /SOPREI_PAYS_META/);
  // Nenhum número de versão de plano fixo: a versão é o máximo + 1 do próprio código.
  assert.match(code, /COALESCE\(MAX\(p\."version"\), 0\) \+ 1/);
});

test('sobre o catálogo da 031: o catálogo vigente vira o novo e as linhas antigas ficam idênticas', async () => {
  await withSchema(async (client) => {
    const before = await snapshot(client);
    assert.equal(before.plans.length, 3);
    assert.equal(before.prices.length, 6);

    await client.query(await readFile(MIGRATION, 'utf8'));

    // Relógio de teste anterior ao deploy (data fixa de novembro de 2026) e o de agora: o mesmo catálogo.
    for (const now of [new Date('2026-11-10T12:00:00Z'), new Date()]) {
      assertNewCatalog((await client.query<CatalogRow>(CATALOG_SQL, [now])).rows);
    }
    const versions = await client.query<{ code: string; version: number }>(
      'SELECT code::text AS code, max(version) AS version FROM plans GROUP BY code ORDER BY code',
    );
    assert.deepEqual(versions.rows, [
      { code: 'ESSENTIAL', version: 2 },
      { code: 'PROFESSIONAL', version: 2 },
      { code: 'SCALE', version: 2 },
    ]);

    // Toda linha antiga, coluna a coluna, igual à de antes (append-only).
    const after = await snapshot(client);
    for (const row of before.plans) assert.ok(after.plans.includes(row), row);
    for (const row of before.prices) assert.ok(after.prices.includes(row), row);
    assert.equal(after.plans.length, 6);
    assert.equal(after.prices.length, 12);

    // Nenhuma linha nova no modo S (o modo S precisaria de catálogo próprio).
    const modes = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM plan_prices pp JOIN plans p ON p.id = pp.plan_id
       WHERE p.version = 2 AND pp.whatsapp_billing_mode <> 'CUSTOMER_PAYS_META'`,
    );
    assert.equal(modes.rows[0]?.n, '0');
  });
});

test('com versões extras do Essencial (o caso da produção) cria a versão máx + 1 sem erro de unicidade', async () => {
  await withSchema(async (client) => {
    // Plan versões 2 e 3 do Essencial (a 3 neutralizando a 2) e PlanPrice versões 2 e 3 no plano 1.
    await client.query(`
      INSERT INTO plans (id, code, name, max_companies, monthly_tokens, monthly_replies,
                         meta_estimate_milli_cents, version, active)
      SELECT gen_random_uuid(), code, name, max_companies, monthly_tokens, monthly_replies,
             meta_estimate_milli_cents, v.version, true
      FROM plans, (VALUES (2), (3)) AS v(version)
      WHERE code = 'ESSENTIAL' AND plans.version = 1`);
    await client.query(`
      INSERT INTO plan_prices (id, plan_id, cycle, base_cents, agenda_cents, stock_cents,
                               whatsapp_billing_mode, meta_per_reply_milli_cents, extra_pack_cents,
                               extra_pack_replies, version, valid_from)
      SELECT gen_random_uuid(), pp.plan_id, pp.cycle, v.base, pp.agenda_cents, pp.stock_cents,
             pp.whatsapp_billing_mode, pp.meta_per_reply_milli_cents, pp.extra_pack_cents,
             pp.extra_pack_replies, v.version, pp.valid_from
      FROM plan_prices pp
      JOIN plans p ON p.id = pp.plan_id AND p.code = 'ESSENTIAL' AND p.version = 1
      CROSS JOIN (VALUES (2, 100), (3, 5900)) AS v(version, base)
      WHERE pp.cycle = 'MONTHLY'`);
    const before = await snapshot(client);

    await client.query(await readFile(MIGRATION, 'utf8'));

    const versions = await client.query<{ code: string; version: number }>(
      'SELECT code::text AS code, max(version) AS version FROM plans GROUP BY code ORDER BY code',
    );
    assert.deepEqual(versions.rows, [
      { code: 'ESSENTIAL', version: 4 },
      { code: 'PROFESSIONAL', version: 2 },
      { code: 'SCALE', version: 2 },
    ]);
    assertNewCatalog((await client.query<CatalogRow>(CATALOG_SQL, [new Date()])).rows);
    // Os preços novos do Essencial pertencem só à versão 4 (nenhum preço novo nas versões antigas).
    const perVersion = await client.query<{ version: number; n: string }>(
      `SELECT p.version, count(*) AS n FROM plan_prices pp JOIN plans p ON p.id = pp.plan_id
       WHERE p.code = 'ESSENTIAL' GROUP BY p.version ORDER BY p.version`,
    );
    assert.deepEqual(perVersion.rows, [
      { version: 1, n: '4' },
      { version: 4, n: '2' },
    ]);
    const after = await snapshot(client);
    for (const row of before.plans) assert.ok(after.plans.includes(row), row);
    for (const row of before.prices) assert.ok(after.prices.includes(row), row);
  });
});
