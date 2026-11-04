import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';

// Spec 022: a migration de renome, exercitada em schema temporário (numa transação que sempre sofre
// rollback; nada compartilhado é alterado). O schema ANTIGO é montado reaplicando as migrations
// anteriores, então os nomes antigos abaixo (clients, users, client_id...) são de propósito.
const config = loadIntegrationConfig();
const MIGRATIONS = new URL('../../../prisma/migrations/', import.meta.url);
const RENAME = '_rename_company_membership';

async function migrationSql(): Promise<{ before: string[]; rename: string }> {
  const names = (await readdir(MIGRATIONS)).filter((name) => /^[0-9]{14}_/.test(name)).sort();
  const renameName = names.find((name) => name.endsWith(RENAME));
  assert.ok(renameName !== undefined, 'a migration de renome existe');
  const before: string[] = [];
  for (const name of names) {
    if (name >= renameName) continue;
    before.push(await readFile(new URL(`${name}/migration.sql`, MIGRATIONS), 'utf8'));
  }
  const rename = await readFile(new URL(`${renameName}/migration.sql`, MIGRATIONS), 'utf8');
  return { before, rename };
}

interface Seed {
  companyA: string;
  companyB: string;
  membershipA: string;
  membershipB: string;
  accountId: string;
  conversationA: string;
  contactMessage: string;
  reply: string;
}

/** Cria o schema temporário no formato anterior à 022 e o popula com dados de duas empresas. */
async function buildOldSchema(
  client: pg.Client,
  before: readonly string[],
): Promise<{ schema: string; seed: Seed }> {
  const schema = `soprei_rename_${randomUUID().replaceAll('-', '')}`;
  await client.query('BEGIN');
  await client.query(`CREATE SCHEMA "${schema}"`);
  // Só o schema temporário no caminho: nada de `public` (o formato novo não pode vazar para o teste).
  await client.query(`SET LOCAL search_path TO "${schema}"`);
  for (const sql of before) await client.query(sql);
  const seed: Seed = {
    companyA: randomUUID(),
    companyB: randomUUID(),
    membershipA: randomUUID(),
    membershipB: randomUUID(),
    accountId: randomUUID(),
    conversationA: randomUUID(),
    contactMessage: randomUUID(),
    reply: randomUUID(),
  };
  await client.query(
    `INSERT INTO clients (id, name, slug, status, persona, whatsapp_phone_number_id, updated_at)
     VALUES ($1, 'Empresa A', 'a', 'ACTIVE', 'persona', '123', now()), ($2, 'Empresa B', 'b', 'SUSPENDED', NULL, NULL, now())`,
    [seed.companyA, seed.companyB],
  );
  await client.query(
    `INSERT INTO accounts (id, email, password_hash, status, email_verified_at)
     VALUES ($1, 'pessoa@example.test', 'hash-conta', 'ACTIVE', now())`,
    [seed.accountId],
  );
  await client.query(
    `INSERT INTO users (id, client_id, email, password_hash, role, status, account_id, updated_at)
     VALUES ($1, $3, 'a@example.test', 'hash-a', 'OWNER', 'ACTIVE', $5, now()),
            ($2, $4, 'b@example.test', 'hash-b', 'VIEWER', 'DISABLED', NULL, now())`,
    [seed.membershipA, seed.membershipB, seed.companyA, seed.companyB, seed.accountId],
  );
  await client.query(
    `INSERT INTO conversations (id, client_id, contact_ref, updated_at) VALUES ($1, $2, 'contato', now())`,
    [seed.conversationA, seed.companyA],
  );
  await client.query(
    `INSERT INTO messages (id, client_id, conversation_id, role, content, external_id, created_at)
     VALUES ($1, $2, $3, 'USER', 'pergunta', 'wamid.1', now())`,
    [seed.contactMessage, seed.companyA, seed.conversationA],
  );
  await client.query(
    `INSERT INTO messages (id, client_id, conversation_id, role, content, reply_to_id, created_at)
     VALUES ($1, $2, $3, 'ASSISTANT', 'resposta', $4, now() + interval '1 second')`,
    [seed.reply, seed.companyA, seed.conversationA, seed.contactMessage],
  );
  await client.query('UPDATE messages SET answered_by_id = $1 WHERE id = $2', [
    seed.reply,
    seed.contactMessage,
  ]);
  await client.query(
    `INSERT INTO audit_events (id, client_id, action, actor_user_id, target_user_id, from_role, to_role)
     VALUES ($1, $3, 'USER_ROLE_CHANGED', $4, $4, 'AGENT', 'OWNER'),
            ($2, $3, 'CHANNEL_CONNECTED', $4, NULL, NULL, NULL)`,
    [randomUUID(), randomUUID(), seed.companyA, seed.membershipA],
  );
  await client.query(
    `INSERT INTO channel_connections (id, client_id, waba_id, token_ciphertext, updated_at)
     VALUES ($1, $2, '999', 'v1.k1.cifrado', now())`,
    [randomUUID(), seed.companyA],
  );
  return { schema, seed };
}

/** Roda `sql` num SAVEPOINT e devolve o erro (ou `undefined`), sempre desfazendo o que fez. */
async function failure(
  client: pg.Client,
  sql: string,
  values: unknown[] = [],
): Promise<string | undefined> {
  await client.query('SAVEPOINT tentativa');
  try {
    await client.query(sql, values);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT tentativa');
  }
}

test('a migration de renome preserva os dados, mantém as FKs compostas e os CHECKs, e não deixa nome antigo', async () => {
  const { before, rename } = await migrationSql();
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  try {
    const { seed } = await buildOldSchema(client, before);
    await client.query(rename);

    // Dados e valores sobreviveram, com os nomes novos.
    const companies = await client.query<{
      id: string;
      name: string;
      status: string;
      persona: string | null;
    }>('SELECT id, name, status, persona FROM companies ORDER BY slug');
    assert.deepEqual(
      companies.rows.map((row) => [row.id, row.name, row.status, row.persona]),
      [
        [seed.companyA, 'Empresa A', 'ACTIVE', 'persona'],
        [seed.companyB, 'Empresa B', 'SUSPENDED', null],
      ],
    );
    const memberships = await client.query<{
      id: string;
      company_id: string;
      role: string;
      status: string;
      account_id: string | null;
      password_hash: string;
    }>(
      'SELECT id, company_id, role, status, account_id, password_hash FROM memberships ORDER BY email',
    );
    assert.deepEqual(
      memberships.rows.map((row) => [
        row.id,
        row.company_id,
        row.role,
        row.status,
        row.account_id,
        row.password_hash,
      ]),
      [
        [seed.membershipA, seed.companyA, 'OWNER', 'ACTIVE', seed.accountId, 'hash-a'],
        [seed.membershipB, seed.companyB, 'VIEWER', 'DISABLED', null, 'hash-b'],
      ],
    );
    const accountStatus = await client.query<{ status: string }>('SELECT status FROM accounts');
    assert.deepEqual(accountStatus.rows, [{ status: 'ACTIVE' }]);
    const messages = await client.query<{
      id: string;
      company_id: string;
      reply_to_id: string | null;
      answered_by_id: string | null;
    }>('SELECT id, company_id, reply_to_id, answered_by_id FROM messages ORDER BY created_at');
    assert.deepEqual(
      messages.rows.map((row) => [row.id, row.company_id, row.reply_to_id, row.answered_by_id]),
      [
        [seed.contactMessage, seed.companyA, null, seed.reply],
        [seed.reply, seed.companyA, seed.contactMessage, null],
      ],
    );
    const audit = await client.query<{
      action: string;
      actor_membership_id: string;
      target_membership_id: string | null;
    }>(
      'SELECT action::text, actor_membership_id, target_membership_id FROM audit_events ORDER BY action::text',
    );
    assert.deepEqual(
      audit.rows.map((row) => [row.action, row.actor_membership_id, row.target_membership_id]),
      [
        ['CHANNEL_CONNECTED', seed.membershipA, null],
        ['MEMBERSHIP_ROLE_CHANGED', seed.membershipA, seed.membershipA],
      ],
    );
    const connections = await client.query('SELECT company_id FROM channel_connections');
    assert.deepEqual(connections.rows, [{ company_id: seed.companyA }]);
    const enumValues = await client.query<{ label: string }>(
      `SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'audit_action' AND t.typnamespace = current_schema()::regnamespace
       ORDER BY e.enumsortorder`,
    );
    assert.deepEqual(
      enumValues.rows.map((row) => row.label),
      [
        'MEMBERSHIP_CREATED',
        'MEMBERSHIP_ROLE_CHANGED',
        'MEMBERSHIP_DISABLED',
        'MEMBERSHIP_ENABLED',
        'MEMBERSHIP_PASSWORD_RESET',
        'MEMBERSHIP_PASSWORD_CHANGED',
        'CHANNEL_CONNECTED',
        'CHANNEL_TOKEN_REPLACED',
        'CHANNEL_DISCONNECTED',
      ],
    );

    // As chaves estrangeiras seguem COMPOSTAS: ligar dado de uma empresa a dado de outra falha no banco.
    const conversationB = randomUUID();
    await client.query(
      `INSERT INTO conversations (id, company_id, contact_ref, updated_at) VALUES ($1, $2, 'outro', now())`,
      [conversationB, seed.companyB],
    );
    const crossMessage = await failure(
      client,
      `INSERT INTO messages (id, company_id, conversation_id, role, content) VALUES ($1, $2, $3, 'USER', 'x')`,
      [randomUUID(), seed.companyB, seed.conversationA],
    );
    assert.match(crossMessage ?? '', /messages_conversation_id_company_id_fkey/);
    const crossReply = await failure(
      client,
      `INSERT INTO messages (id, company_id, conversation_id, role, content, reply_to_id)
       VALUES ($1, $2, $3, 'ASSISTANT', 'x', $4)`,
      [randomUUID(), seed.companyB, conversationB, seed.contactMessage],
    );
    assert.match(crossReply ?? '', /messages_reply_to_id_company_id_fkey/);
    const crossAnswerOther = await failure(
      client,
      `INSERT INTO messages (id, company_id, conversation_id, role, content, answered_by_id)
       VALUES ($1, $2, $3, 'USER', 'x', $4)`,
      [randomUUID(), seed.companyB, conversationB, seed.reply],
    );
    assert.match(crossAnswerOther ?? '', /messages_answered_by_id_company_id_fkey/);
    const crossAudit = await failure(
      client,
      `INSERT INTO audit_events (id, company_id, action, actor_membership_id, target_membership_id)
       VALUES ($1, $2, 'MEMBERSHIP_DISABLED', $3, $3)`,
      [randomUUID(), seed.companyB, seed.membershipA],
    );
    assert.match(crossAudit ?? '', /audit_events_actor_membership_id_company_id_fkey/);
    const crossTarget = await failure(
      client,
      `INSERT INTO audit_events (id, company_id, action, actor_membership_id, target_membership_id)
       VALUES ($1, $2, 'MEMBERSHIP_DISABLED', $3, $4)`,
      [randomUUID(), seed.companyB, seed.membershipB, seed.membershipA],
    );
    assert.match(crossTarget ?? '', /audit_events_target_membership_id_company_id_fkey/);

    // CHECKs: os que só citam colunas e o CHECK por ação recriado com o prefixo novo.
    assert.match(
      (await failure(
        client,
        `INSERT INTO audit_events (id, company_id, action, actor_membership_id, target_membership_id)
         VALUES ($1, $2, 'MEMBERSHIP_DISABLED', $3, NULL)`,
        [randomUUID(), seed.companyA, seed.membershipA],
      )) ?? '',
      /audit_events_target_by_action_check/,
    );
    assert.match(
      (await failure(
        client,
        `INSERT INTO audit_events (id, company_id, action, actor_membership_id, target_membership_id)
         VALUES ($1, $2, 'CHANNEL_DISCONNECTED', $3, $3)`,
        [randomUUID(), seed.companyA, seed.membershipA],
      )) ?? '',
      /audit_events_target_by_action_check/,
    );
    assert.equal(
      await failure(
        client,
        `INSERT INTO audit_events (id, company_id, action, actor_membership_id, target_membership_id)
         VALUES ($1, $2, 'MEMBERSHIP_ENABLED', $3, $3)`,
        [randomUUID(), seed.companyA, seed.membershipA],
      ),
      undefined,
    );
    assert.match(
      (await failure(client, `UPDATE companies SET persona = '' WHERE id = $1`, [seed.companyA])) ??
        '',
      /companies_persona_length_check/,
    );
    assert.match(
      (await failure(
        client,
        `UPDATE companies SET whatsapp_phone_number_id = 'abc' WHERE id = $1`,
        [seed.companyA],
      )) ?? '',
      /companies_whatsapp_phone_number_id_format_check/,
    );
    assert.match(
      (await failure(client, `UPDATE channel_connections SET waba_id = 'x' WHERE company_id = $1`, [
        seed.companyA,
      ])) ?? '',
      /channel_connections_waba_id_check/,
    );
    assert.match(
      (await failure(client, `UPDATE messages SET answered_by_id = $1 WHERE id = $2`, [
        seed.contactMessage,
        seed.reply,
      ])) ?? '',
      /messages_answered_by_only_contact_check/,
    );
    assert.match(
      (await failure(client, `UPDATE messages SET is_fallback = true WHERE id = $1`, [
        seed.contactMessage,
      ])) ?? '',
      /messages_fallback_role_check/,
    );

    // O índice parcial de mensagens pendentes e os únicos continuam de pé.
    const indexes = await client.query<{ indexname: string; indexdef: string }>(
      'SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema()',
    );
    const byName = new Map(indexes.rows.map((row) => [row.indexname, row.indexdef]));
    assert.match(byName.get('messages_pending_idx') ?? '', /WHERE/);
    for (const name of [
      'memberships_company_id_email_key',
      'memberships_id_company_id_key',
      'memberships_company_id_account_id_key',
      'memberships_company_id_created_at_id_idx',
      'conversations_id_company_id_key',
      'messages_id_company_id_key',
      'messages_company_id_external_id_key',
      'messages_company_id_reply_to_id_key',
      'channel_connections_company_id_key',
      'companies_slug_key',
      'companies_whatsapp_phone_number_id_key',
    ]) {
      assert.ok(byName.has(name), `índice ${name} existe`);
    }

    // Catálogo: nenhum nome de tabela, coluna, tipo, índice ou constraint com client/user.
    const legacy = await client.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c WHERE c.relnamespace = current_schema()::regnamespace AND c.relname ~* '(client|user)'
       UNION ALL SELECT a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
         WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND a.attname ~* '(client|user)'
       UNION ALL SELECT t.typname FROM pg_type t WHERE t.typnamespace = current_schema()::regnamespace AND t.typname ~* '(client|user)'
       UNION ALL SELECT c.conname FROM pg_constraint c WHERE c.connamespace = current_schema()::regnamespace AND c.conname ~* '(client|user)'`,
    );
    assert.deepEqual(legacy.rows, []);

    // O preflight da própria migration falha se um nome antigo for injetado.
    const preflight = rename.slice(rename.indexOf('-- 7. PREFLIGHT'));
    assert.ok(preflight.includes('RENAME_LEFTOVERS'));
    await client.query('SAVEPOINT limpo');
    await client.query(preflight);
    await client.query('CREATE TABLE users_sobra (id int)');
    await assert.rejects(client.query(preflight), /RENAME_LEFTOVERS: relation users_sobra/);
    await client.query('ROLLBACK TO SAVEPOINT limpo');
    await client.query('ALTER TABLE companies ADD COLUMN client_id_sobra int');
    await assert.rejects(
      client.query(preflight),
      /RENAME_LEFTOVERS: column companies\.client_id_sobra/,
    );
    await client.query('ROLLBACK');
  } finally {
    await client.end();
  }
});

test('a migration é tudo ou nada: falha no meio não deixa nada pela metade', async () => {
  const { before, rename } = await migrationSql();
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  try {
    await buildOldSchema(client, before);
    // Uma tabela `companies` já existente faz o passo 3 falhar DEPOIS de os passos 1 e 2 terem rodado.
    await client.query('CREATE TABLE companies (id int)');
    await client.query('SAVEPOINT migracao');
    await assert.rejects(client.query(rename), /companies/);
    await client.query('ROLLBACK TO SAVEPOINT migracao');
    const state = await client.query<{ kind: string; name: string }>(
      `SELECT 'type' AS kind, typname AS name FROM pg_type
         WHERE typnamespace = current_schema()::regnamespace AND typname IN ('client_status', 'user_role', 'user_status', 'company_status', 'membership_role', 'access_status')
       UNION ALL SELECT 'check', conname FROM pg_constraint
         WHERE connamespace = current_schema()::regnamespace AND conname = 'audit_events_target_by_action_check'
       UNION ALL SELECT 'table', relname FROM pg_class
         WHERE relnamespace = current_schema()::regnamespace AND relkind = 'r' AND relname IN ('clients', 'users', 'memberships')`,
    );
    const names = state.rows.map((row) => `${row.kind}:${row.name}`).sort();
    assert.deepEqual(names, [
      'check:audit_events_target_by_action_check',
      'table:clients',
      'table:users',
      'type:client_status',
      'type:user_role',
      'type:user_status',
    ]);
    const check = await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'audit_events_target_by_action_check'
         AND connamespace = current_schema()::regnamespace`,
    );
    assert.match(check.rows[0]?.def ?? '', /target_user_id/);
    await client.query('ROLLBACK');
  } finally {
    await client.end();
  }
});
