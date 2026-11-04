import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import pg from 'pg';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';

// Spec 022: o schema `public` do banco de testes (migrado do zero ou sobre o schema antigo) não pode
// ter tabela, coluna, tipo, índice nem constraint com `client` ou `user` no nome, e o banco tem de
// bater com o `schema.prisma` (sem drift novo).
const config = loadIntegrationConfig();
const run = promisify(execFile);

// Nomes que contêm client/user mas não são do domínio renomeado: nenhum hoje (lista declarada vazia).
const ALLOWED_NAMES: ReadonlySet<string> = new Set();

test('catálogo: nenhum nome com client ou user no schema public', async () => {
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  try {
    const found = await client.query<{ kind: string; name: string }>(
      `SELECT 'relation' AS kind, c.relname AS name FROM pg_class c
         WHERE c.relnamespace = 'public'::regnamespace AND c.relname ~* '(client|user)'
       UNION ALL SELECT 'column', c.relname || '.' || a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
         WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
           AND a.attname ~* '(client|user)'
       UNION ALL SELECT 'type', t.typname FROM pg_type t
         WHERE t.typnamespace = 'public'::regnamespace AND t.typname ~* '(client|user)'
       UNION ALL SELECT 'constraint', c.conname FROM pg_constraint c
         WHERE c.connamespace = 'public'::regnamespace AND c.conname ~* '(client|user)'
       UNION ALL SELECT 'enum value', t.typname || '.' || e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typnamespace = 'public'::regnamespace AND t.typname = 'audit_action' AND e.enumlabel ~* '(client|user)'`,
    );
    const leftovers = found.rows.filter((row) => !ALLOWED_NAMES.has(row.name));
    assert.deepEqual(leftovers, []);
    // Os nomes novos existem.
    const tables = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('companies', 'memberships') ORDER BY 1`,
    );
    assert.deepEqual(
      tables.rows.map((row) => row.tablename),
      ['companies', 'memberships'],
    );
  } finally {
    await client.end();
  }
});

// Diferenças que já existiam antes da 022 e que a 022 não pode (nem deve) mexer: `accounts.updated_at`
// guarda um DEFAULT no banco porque o INSERT cru de `AccountRepository.register` depende dele, e a
// FK `memberships_account_id_fkey` foi criada pela 017 sem `ON UPDATE CASCADE`. Qualquer outra
// diferença (por exemplo um nome de constraint que não bate com o do Prisma) é drift novo e falha.
const KNOWN_DRIFT: readonly string[] = [
  'ALTER TABLE "memberships" DROP CONSTRAINT "memberships_account_id_fkey"',
  'ALTER TABLE "accounts" ALTER COLUMN "updated_at" DROP DEFAULT',
  'ALTER TABLE "memberships" ADD CONSTRAINT "memberships_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE',
];

test('drift: o banco migrado bate com o schema.prisma (salvo as duas diferenças anteriores à 022)', async () => {
  const backend = process.cwd();
  const prismaCli = join(backend, 'node_modules', 'prisma', 'build', 'index.js');
  const { stdout } = await run(
    process.execPath,
    [
      prismaCli,
      'migrate',
      'diff',
      '--from-config-datasource',
      '--to-schema',
      join(backend, 'prisma', 'schema.prisma'),
      '--script',
    ],
    { cwd: backend, env: { ...process.env, DATABASE_URL: config.DATABASE_URL } },
  );
  const statements = stdout
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('--') && !line.startsWith('Loaded'))
    .join(' ')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');
  assert.deepEqual(statements, KNOWN_DRIFT);
});
