import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';

// Spec 045, E3b: a migration do convidador da plataforma aplica sobre o schema anterior (o da 025 com a
// trilha da plataforma), mantém válidos os convites existentes e impõe os CHECKs novos. Roda num schema
// temporário dentro de uma transação que sempre sofre rollback: nada compartilhado é alterado.
const config = loadIntegrationConfig();

test('migration da 045 E3b: convites antigos continuam válidos; exatamente um convidador; OWNER só do admin', async () => {
  const sql = await readFile(
    new URL(
      '../../../prisma/migrations/20261126200000_platform_invitations/migration.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const schema = `soprei_migration_${randomUUID().replaceAll('-', '')}`;
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  const companyId = randomUUID();
  const memberId = randomUUID();
  const adminId = randomUUID();
  const oldInvitation = randomUUID();
  /** Executa e devolve se o banco recusou (SAVEPOINT: uma recusa não aborta a transação). */
  const refused = async (statement: string, values: unknown[] = []): Promise<boolean> => {
    await client.query('SAVEPOINT attempt');
    try {
      await client.query(statement, values);
      await client.query('RELEASE SAVEPOINT attempt');
      return false;
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT attempt');
      return true;
    }
  };
  const invite = (
    role: string,
    membership: string | null,
    admin: string | null,
  ): Promise<boolean> =>
    refused(
      `INSERT INTO company_invitations
         (id, company_id, email, role, token_hash, invited_by_membership_id, invited_by_admin_id,
          expires_at, last_sent_at)
       VALUES ($1, $2, $3, $4::membership_role, 'h', $5, $6, now() + interval '7 days', now())`,
      [randomUUID(), companyId, `${randomUUID()}@x.test`, role, membership, admin],
    );
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    // Pré-requisitos como estavam depois da E3a (só o que a migration toca).
    await client.query("CREATE TYPE membership_role AS ENUM ('OWNER', 'ADMIN', 'AGENT', 'VIEWER')");
    await client.query(
      "CREATE TYPE invitation_status AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED')",
    );
    await client.query(
      "CREATE TYPE platform_audit_action AS ENUM ('PLATFORM_LOGIN', 'COMPANY_REMOVED')",
    );
    await client.query('CREATE TABLE companies (id uuid PRIMARY KEY)');
    await client.query('CREATE TABLE platform_admins (id uuid PRIMARY KEY)');
    await client.query(`CREATE TABLE memberships (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id))`);
    await client.query(
      'CREATE UNIQUE INDEX memberships_id_company_id_key ON memberships (id, company_id)',
    );
    await client.query(`CREATE TABLE company_invitations (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      email text,
      role membership_role NOT NULL,
      status invitation_status NOT NULL DEFAULT 'PENDING',
      token_hash text,
      invited_by_membership_id uuid NOT NULL,
      expires_at timestamptz(6) NOT NULL,
      last_sent_at timestamptz(6) NOT NULL,
      FOREIGN KEY (invited_by_membership_id, company_id) REFERENCES memberships (id, company_id))`);
    await client.query(
      `ALTER TABLE company_invitations ADD CONSTRAINT company_invitations_role_check CHECK (role <> 'OWNER')`,
    );
    await client.query(`CREATE TABLE platform_audit_events (
      id uuid PRIMARY KEY,
      admin_id uuid NOT NULL REFERENCES platform_admins(id),
      action platform_audit_action NOT NULL)`);
    await client.query('INSERT INTO companies (id) VALUES ($1)', [companyId]);
    await client.query('INSERT INTO platform_admins (id) VALUES ($1)', [adminId]);
    await client.query('INSERT INTO memberships (id, company_id) VALUES ($1, $2)', [
      memberId,
      companyId,
    ]);
    await client.query(
      `INSERT INTO company_invitations
         (id, company_id, email, role, token_hash, invited_by_membership_id, expires_at, last_sent_at)
       VALUES ($1, $2, 'antigo@x.test', 'AGENT', 'h', $3, now() + interval '7 days', now())`,
      [oldInvitation, companyId, memberId],
    );

    await client.query(sql);

    // O convite antigo continua lá, com o convidador de vínculo e sem admin.
    const old = await client.query<{ by_member: string; by_admin: string | null }>(
      'SELECT invited_by_membership_id AS by_member, invited_by_admin_id AS by_admin FROM company_invitations WHERE id = $1',
      [oldInvitation],
    );
    assert.deepEqual(old.rows, [{ by_member: memberId, by_admin: null }]);
    // Exatamente um convidador.
    assert.equal(await invite('AGENT', memberId, adminId), true, 'os dois convidadores');
    assert.equal(await invite('AGENT', null, null), true, 'nenhum convidador');
    // OWNER só pela plataforma.
    assert.equal(await invite('OWNER', memberId, null), true, 'OWNER com convidador vínculo');
    assert.equal(await invite('OWNER', null, adminId), false, 'OWNER com convidador admin');
    assert.equal(await invite('AGENT', null, adminId), false, 'atendente pela plataforma');
    assert.equal(await invite('AGENT', memberId, null), false, 'convite de vínculo como antes');
    // Admin inexistente: a FK recusa.
    assert.equal(await invite('AGENT', null, randomUUID()), true, 'admin inexistente');
    // A trilha da plataforma aponta para o convite.
    assert.equal(
      await refused(
        `INSERT INTO platform_audit_events (id, admin_id, action, subject_invitation_id)
         VALUES ($1, $2, 'PLATFORM_LOGIN', $3)`,
        [randomUUID(), adminId, oldInvitation],
      ),
      false,
    );
    assert.equal(
      await refused(
        `INSERT INTO platform_audit_events (id, admin_id, action, subject_invitation_id)
         VALUES ($1, $2, 'PLATFORM_LOGIN', $3)`,
        [randomUUID(), adminId, randomUUID()],
      ),
      true,
      'convite inexistente na trilha',
    );
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
});
