import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';

const config = loadIntegrationConfig();
test('preflight da migration recusa colisão de e-mail sem escolher senha ou unir vínculos', async () => {
  const sql = await readFile(
    new URL(
      '../../../prisma/migrations/20261103140000_global_accounts/migration.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const guard = sql.split('CREATE TABLE accounts')[0];
  const statusSql = await readFile(
    new URL(
      '../../../prisma/migrations/20261103141000_preserve_membership_disable_scope/migration.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.ok(guard);
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    // A tabela temporária sombreia users somente nesta conexão e some com rollback/close.
    await client.query('CREATE TEMP TABLE users (email text)');
    await client.query(
      "INSERT INTO users VALUES ('repetido@example.test'), ('repetido@example.test')",
    );
    await assert.rejects(client.query(guard), /ACCOUNT_EMAIL_COLLISIONS/);
    await client.query('ROLLBACK');
    // Diferença só de caixa também é colisão (a conta global normaliza para minúsculas).
    await client.query('BEGIN');
    await client.query('CREATE TEMP TABLE users (email text)');
    await client.query("INSERT INTO users VALUES ('Misto@Example.test'), ('misto@example.TEST')");
    await assert.rejects(client.query(guard), /ACCOUNT_EMAIL_COLLISIONS/);
    await client.query('ROLLBACK');
    await client.query('BEGIN');
    await client.query('CREATE TEMP TABLE users (email text)');
    await client.query("INSERT INTO users VALUES ('unico@example.test')");
    await client.query(guard);
    await client.query('ROLLBACK');
    // Exercita a migration inteira com dados legados, em schema criado numa transação
    // que sempre sofre rollback. Nenhuma tabela/linha compartilhada é alterada.
    const schema = `soprei_migration_${randomUUID().replaceAll('-', '')}`;
    const legacyId = randomUUID();
    const disabledId = randomUUID();
    const legacyClientId = randomUUID();
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    await client.query(
      'CREATE TABLE users (id uuid PRIMARY KEY, client_id uuid NOT NULL, email text, password_hash text, status user_status, created_at timestamp(3), updated_at timestamp(3), UNIQUE (id, client_id))',
    );
    await client.query(
      'CREATE TABLE audit_events (actor_user_id uuid, client_id uuid, FOREIGN KEY (actor_user_id, client_id) REFERENCES users(id, client_id))',
    );
    await client.query(
      "INSERT INTO users VALUES ($1, $2, 'Legado@Example.test', 'legacy-hash-preserved', 'ACTIVE', now(), now())",
      [legacyId, legacyClientId],
    );
    await client.query('INSERT INTO audit_events VALUES ($1, $2)', [legacyId, legacyClientId]);
    await client.query(
      "INSERT INTO users VALUES ($1, $2, 'disabled@example.test', 'legacy-disabled-hash', 'DISABLED', now(), now())",
      [disabledId, legacyClientId],
    );
    await client.query(sql);
    await client.query(statusSql);
    const disabled = await client.query<{ account_status: string; member_status: string }>(
      'SELECT a.status AS account_status, u.status AS member_status FROM accounts a JOIN users u ON u.account_id = a.id WHERE a.id = $1',
      [disabledId],
    );
    assert.deepEqual(disabled.rows, [{ account_status: 'ACTIVE', member_status: 'DISABLED' }]);
    const lowered = await client.query<{ email: string }>(
      'SELECT email FROM accounts WHERE id = $1',
      [legacyId],
    );
    assert.deepEqual(lowered.rows, [{ email: 'legado@example.test' }]);
    const migrated = await client.query<{
      user_id: string;
      account_id: string;
      actor_user_id: string;
      password_hash: string;
      verified: Date | null;
    }>(
      'SELECT u.id AS user_id, u.account_id, e.actor_user_id, a.password_hash, a.email_verified_at AS verified FROM users u JOIN accounts a ON a.id = u.account_id JOIN audit_events e ON e.actor_user_id = u.id',
    );
    assert.deepEqual(migrated.rows, [
      {
        user_id: legacyId,
        account_id: legacyId,
        actor_user_id: legacyId,
        password_hash: 'legacy-hash-preserved',
        verified: null,
      },
    ]);
    await client.query('ROLLBACK');
  } finally {
    await client.end();
  }
});

test('migration da 020 é aditiva: zera só os códigos pendentes, preserva as confirmadas e afrouxa o CHECK', async () => {
  const migrations = new URL('../../../prisma/migrations/', import.meta.url);
  const original = await readFile(
    new URL('20261103140000_global_accounts/migration.sql', migrations),
    'utf8',
  );
  const sql = await readFile(
    new URL('20261103150000_account_verification_attempts/migration.sql', migrations),
    'utf8',
  );
  // A migration da 017 continua como estava (a 020 não a reescreve) e a nova vem depois das outras.
  assert.match(original, /CONSTRAINT account_verification_pair CHECK/);
  const names = (await readdir(migrations)).filter((name) => /^[0-9]{14}_/.test(name)).sort();
  const previous = names.indexOf('20261103141000_preserve_membership_disable_scope');
  const current = names.indexOf('20261103150000_account_verification_attempts');
  assert.ok(previous >= 0 && current > previous);
  // Aditiva: nenhuma remoção de tabela, coluna ou dado (só o CHECK é trocado e as pendentes zeradas).
  assert.doesNotMatch(sql, /DROP\s+(TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM/i);
  const definition = /CREATE TABLE accounts \([\s\S]*?\n\);/.exec(original)?.[0];
  assert.ok(definition);
  const schema = `soprei_migration_${randomUUID().replaceAll('-', '')}`;
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  try {
    // Schema temporário numa transação que sempre sofre rollback: nada compartilhado é alterado.
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    await client.query(definition);
    const pendingId = randomUUID();
    const confirmedId = randomUUID();
    await client.query(
      `INSERT INTO accounts (id, email, password_hash, verification_hash, verification_expires_at)
       VALUES ($1, 'pendente@example.test', 'hash', 'sha256-antigo', now() + interval '10 minutes')`,
      [pendingId],
    );
    await client.query(
      `INSERT INTO accounts (id, email, password_hash, email_verified_at)
       VALUES ($1, 'confirmada@example.test', 'hash', '2026-11-01T10:00:00Z')`,
      [confirmedId],
    );
    await client.query(sql);
    const rows = await client.query<{
      id: string;
      verification_hash: string | null;
      verification_expires_at: Date | null;
      email_verified_at: Date | null;
      verification_attempts: number;
      verification_failures_day: number;
      verification_failures_since: Date | null;
    }>('SELECT * FROM accounts');
    const pending = rows.rows.find((row) => row.id === pendingId);
    const confirmed = rows.rows.find((row) => row.id === confirmedId);
    assert.ok(pending && confirmed);
    assert.equal(pending.verification_hash, null);
    assert.equal(pending.verification_expires_at, null);
    assert.equal(pending.email_verified_at, null);
    assert.equal(confirmed.email_verified_at?.toISOString(), '2026-11-01T10:00:00.000Z');
    for (const row of [pending, confirmed]) {
      assert.equal(row.verification_attempts, 0);
      assert.equal(row.verification_failures_day, 0);
      assert.equal(row.verification_failures_since, null);
    }
    // Código esgotado: sem hash e com vencimento é permitido; hash sem vencimento, não.
    await client.query(
      "UPDATE accounts SET verification_hash = 'h', verification_expires_at = now() WHERE id = $1",
      [pendingId],
    );
    await client.query('UPDATE accounts SET verification_hash = NULL WHERE id = $1', [pendingId]);
    await client.query('SAVEPOINT antes_do_check');
    await assert.rejects(
      client.query(
        "UPDATE accounts SET verification_hash = 'h', verification_expires_at = NULL WHERE id = $1",
        [pendingId],
      ),
      /account_verification_expiry/,
    );
    await client.query('ROLLBACK TO SAVEPOINT antes_do_check');
    // Contadores nunca negativos.
    await assert.rejects(
      client.query('UPDATE accounts SET verification_attempts = -1 WHERE id = $1', [pendingId]),
      /account_verification_counters_check/,
    );
    await client.query('ROLLBACK');
  } finally {
    await client.end();
  }
});
