import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';

// Spec 039: a migration é ADITIVA e compatível com a versão anterior (regra da 037): sobre o schema
// anterior, as conexões existentes ficam `API_ONLY`, as conversas sem pausa e as mensagens intactas.
// Roda num schema temporário dentro de uma transação que sempre sofre rollback.
const config = loadIntegrationConfig();

test('migration da 039: mode com default, pausas nulas, HUMAN no enum e o índice, sem perder dado', async () => {
  const sql = await readFile(
    new URL(
      '../../../prisma/migrations/20261112100000_channel_coexistence/migration.sql',
      import.meta.url,
    ),
    'utf8',
  );
  // A varredura de texto do deploy (spec 037) não pode achar nada destrutivo.
  assert.equal(
    /\b(DROP|RENAME|TRUNCATE)\b|SET\s+NOT\s+NULL|DELETE\s+FROM|ALTER\s+COLUMN[^;]*TYPE\b/.test(sql),
    false,
  );
  const schema = `soprei_migration_${randomUUID().replaceAll('-', '')}`;
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  const companyId = randomUUID();
  const conversationId = randomUUID();
  const messageId = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    await client.query(`CREATE TYPE "${schema}"."message_role" AS ENUM ('USER', 'ASSISTANT')`);
    await client.query(
      'CREATE TABLE channel_connections (id uuid PRIMARY KEY, company_id uuid NOT NULL)',
    );
    await client.query(
      'CREATE TABLE conversations (id uuid PRIMARY KEY, company_id uuid NOT NULL, contact_ref text NOT NULL)',
    );
    await client.query(
      `CREATE TABLE messages (id uuid PRIMARY KEY, company_id uuid NOT NULL, conversation_id uuid NOT NULL,
       role "${schema}"."message_role" NOT NULL, content text NOT NULL, channel_message_id text)`,
    );
    await client.query('INSERT INTO channel_connections (id, company_id) VALUES ($1, $2)', [
      randomUUID(),
      companyId,
    ]);
    await client.query(
      "INSERT INTO conversations (id, company_id, contact_ref) VALUES ($1, $2, 'c1')",
      [conversationId, companyId],
    );
    await client.query(
      "INSERT INTO messages (id, company_id, conversation_id, role, content) VALUES ($1, $2, $3, 'USER', 'oi')",
      [messageId, companyId, conversationId],
    );

    await client.query(sql);

    const connection = await client.query<{ mode: string }>('SELECT mode FROM channel_connections');
    assert.deepEqual(
      connection.rows.map((row) => row.mode),
      ['API_ONLY'],
    );
    const conversation = await client.query<{
      ai_paused_until: Date | null;
      ai_ignore_before: Date | null;
      contact_ref: string;
    }>('SELECT ai_paused_until, ai_ignore_before, contact_ref FROM conversations');
    assert.deepEqual(conversation.rows, [
      { ai_paused_until: null, ai_ignore_before: null, contact_ref: 'c1' },
    ]);
    const message = await client.query<{ role: string; content: string }>(
      'SELECT role, content FROM messages WHERE id = $1',
      [messageId],
    );
    assert.deepEqual(message.rows, [{ role: 'USER', content: 'oi' }]);
    const labels = await client.query<{ enumlabel: string }>(
      `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = $1 AND t.typname = 'message_role' ORDER BY e.enumsortorder`,
      [schema],
    );
    assert.deepEqual(
      labels.rows.map((row) => row.enumlabel),
      ['USER', 'ASSISTANT', 'HUMAN'],
    );
    const index = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'messages'
       AND indexname = 'messages_company_id_channel_message_id_idx'`,
      [schema],
    );
    assert.equal(index.rows.length, 1);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
