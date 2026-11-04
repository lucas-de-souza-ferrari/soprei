import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { MODEL_SCOPES } from './extensions/tenant-scope.js';

// Spec 025: a migration aplica sobre o schema anterior (estado depois da 022) sem perder dado e deixa
// válidos os eventos de auditoria existentes. Roda num schema temporário dentro de uma transação que
// sempre sofre rollback: nada compartilhado é alterado.
const config = loadIntegrationConfig();

test('migration da 025 aplica sobre o schema anterior, preserva os eventos e impõe os CHECKs novos', async () => {
  const sql = await readFile(
    new URL(
      '../../../prisma/migrations/20261104200000_company_invitations/migration.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const schema = `soprei_migration_${randomUUID().replaceAll('-', '')}`;
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  const companyId = randomUUID();
  const ownerId = randomUUID();
  const agentId = randomUUID();
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
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    // Pré-requisitos da 025 como estavam depois da 022 (só o que a migration toca).
    await client.query("CREATE TYPE membership_role AS ENUM ('OWNER', 'ADMIN', 'AGENT', 'VIEWER')");
    await client.query(`CREATE TYPE audit_action AS ENUM (
      'MEMBERSHIP_CREATED', 'MEMBERSHIP_ROLE_CHANGED', 'MEMBERSHIP_DISABLED', 'MEMBERSHIP_ENABLED',
      'MEMBERSHIP_PASSWORD_RESET', 'MEMBERSHIP_PASSWORD_CHANGED', 'CHANNEL_CONNECTED',
      'CHANNEL_TOKEN_REPLACED', 'CHANNEL_DISCONNECTED')`);
    await client.query('CREATE TABLE companies (id uuid PRIMARY KEY)');
    await client.query(`CREATE TABLE memberships (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      email text NOT NULL,
      role membership_role NOT NULL DEFAULT 'AGENT')`);
    await client.query(
      'CREATE UNIQUE INDEX memberships_id_company_id_key ON memberships (id, company_id)',
    );
    await client.query(`CREATE TABLE audit_events (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      action audit_action NOT NULL,
      actor_membership_id uuid NOT NULL,
      target_membership_id uuid,
      from_role membership_role,
      to_role membership_role,
      created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (actor_membership_id, company_id) REFERENCES memberships (id, company_id),
      FOREIGN KEY (target_membership_id, company_id) REFERENCES memberships (id, company_id))`);
    await client.query(`ALTER TABLE audit_events ADD CONSTRAINT audit_events_target_by_action_check CHECK (
      (action::text LIKE 'MEMBERSHIP\\_%' AND target_membership_id IS NOT NULL)
      OR (action::text LIKE 'CHANNEL\\_%' AND target_membership_id IS NULL))`);
    await client.query('INSERT INTO companies (id) VALUES ($1)', [companyId]);
    await client.query(
      `INSERT INTO memberships (id, company_id, email, role) VALUES ($1, $3, 'o@x.test', 'OWNER'), ($2, $3, 'a@x.test', 'AGENT')`,
      [ownerId, agentId, companyId],
    );
    await client.query(
      `INSERT INTO audit_events (id, company_id, action, actor_membership_id, target_membership_id, to_role)
       VALUES ($1, $2, 'MEMBERSHIP_CREATED', $3, $4, 'AGENT')`,
      [randomUUID(), companyId, ownerId, agentId],
    );
    await client.query(
      `INSERT INTO audit_events (id, company_id, action, actor_membership_id) VALUES ($1, $2, 'CHANNEL_CONNECTED', $3)`,
      [randomUUID(), companyId, ownerId],
    );

    // A migration inteira, como o Prisma a aplica (um lote só).
    await client.query(sql);

    // Os eventos existentes continuam (e válidos: o CHECK recriado foi validado sobre eles).
    const events = await client.query<{ count: string; invitations: string }>(
      'SELECT count(*)::text AS count, count(invitation_id)::text AS invitations FROM audit_events',
    );
    assert.deepEqual(events.rows[0], { count: '2', invitations: '0' });

    const insertInvitation = (
      status: string,
      role: string,
      email: string | null,
      hash: string | null,
      closed: Date | null,
      accepted: string | null = null,
    ) =>
      client.query(
        `INSERT INTO company_invitations
           (id, company_id, email, role, status, token_hash, invited_by_membership_id, accepted_membership_id,
            expires_at, last_sent_at, closed_at)
         VALUES ($1, $2, $3, $4::membership_role, $5::invitation_status, $6, $7, $8, now(), now(), $9)`,
        [randomUUID(), companyId, email, role, status, hash, ownerId, accepted, closed],
      );
    // Convite válido.
    await insertInvitation('PENDING', 'AGENT', 'novo@x.test', 'hash', null);
    // Recusas do banco (cada tentativa num SAVEPOINT, para não abortar a transação).
    const attempt = async (...args: Parameters<typeof insertInvitation>): Promise<boolean> => {
      await client.query('SAVEPOINT convite');
      try {
        await insertInvitation(...args);
        await client.query('RELEASE SAVEPOINT convite');
        return false;
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT convite');
        return true;
      }
    };
    assert.equal(await attempt('PENDING', 'OWNER', 'dono@x.test', 'h', null), true);
    assert.equal(await attempt('REVOKED', 'AGENT', 'fechado@x.test', null, new Date()), true);
    assert.equal(await attempt('PENDING', 'AGENT', 'novo@x.test', 'outro', null), true);

    // O CHECK por ação recusa convite em evento de vínculo e de canal (sem usar os valores novos).
    const invitationId = randomUUID();
    await client.query(
      `INSERT INTO company_invitations
         (id, company_id, email, role, status, token_hash, invited_by_membership_id, expires_at, last_sent_at)
       VALUES ($1, $2, 'ev@x.test', 'VIEWER', 'PENDING', 'h', $3, now(), now())`,
      [invitationId, companyId, ownerId],
    );
    assert.equal(
      await refused(
        `INSERT INTO audit_events (id, company_id, action, actor_membership_id, target_membership_id, invitation_id)
         VALUES ($1, $2, 'MEMBERSHIP_CREATED', $3, $4, $5)`,
        [randomUUID(), companyId, ownerId, agentId, invitationId],
      ),
      true,
    );
    assert.equal(
      await refused(
        `INSERT INTO audit_events (id, company_id, action, actor_membership_id, invitation_id)
         VALUES ($1, $2, 'CHANNEL_CONNECTED', $3, $4)`,
        [randomUUID(), companyId, ownerId, invitationId],
      ),
      true,
    );
    // A chave estrangeira composta recusa convite de outra empresa em evento.
    const otherCompany = randomUUID();
    await client.query('INSERT INTO companies (id) VALUES ($1)', [otherCompany]);
    assert.equal(
      await refused(
        `INSERT INTO company_invitations
           (id, company_id, email, role, status, token_hash, invited_by_membership_id, expires_at, last_sent_at)
         VALUES ($1, $2, 'x@x.test', 'AGENT', 'PENDING', 'h', $3, now(), now())`,
        [randomUUID(), otherCompany, ownerId],
      ),
      true,
    );
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
});

test('o MODEL_SCOPES classifica CompanyInvitation como tenant', () => {
  assert.equal(MODEL_SCOPES.CompanyInvitation, 'tenant');
});
