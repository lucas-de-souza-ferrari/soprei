import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const MIGRATIONS_DIR = join(process.cwd(), 'prisma', 'migrations');

function migrationFiles(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      sql: readFileSync(join(MIGRATIONS_DIR, entry.name, 'migration.sql'), 'utf8'),
    }));
}

describe('migration da spec 008 (RBAC e auditoria)', () => {
  const migration = migrationFiles().find((file) => file.name.endsWith('_rbac_audit'));

  it('existe e só acrescenta: nenhum DROP, DELETE FROM, TRUNCATE, RENAME nem ALTER COLUMN', () => {
    assert.ok(migration !== undefined, 'migration _rbac_audit existe');
    const statements = migration.sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    for (const forbidden of [
      /\bDROP\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bTRUNCATE\b/i,
      /\bRENAME\b/i,
      /ALTER\s+COLUMN/i,
    ]) {
      assert.doesNotMatch(statements, forbidden);
    }
    // O que ela faz: dois valores novos no enum, o tipo e a tabela de auditoria, o índice único
    // de users e as chaves estrangeiras compostas.
    assert.match(statements, /ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'ADMIN'/);
    assert.match(statements, /ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'VIEWER'/);
    assert.match(statements, /CREATE TYPE "audit_action"/);
    assert.match(statements, /CREATE TABLE "audit_events"/);
    assert.match(statements, /CREATE UNIQUE INDEX "users_id_client_id_key"/);
    assert.match(
      statements,
      /FOREIGN KEY \("actor_user_id", "client_id"\) REFERENCES "users"\("id", "client_id"\) ON DELETE RESTRICT/,
    );
    assert.match(
      statements,
      /FOREIGN KEY \("target_user_id", "client_id"\) REFERENCES "users"\("id", "client_id"\) ON DELETE RESTRICT/,
    );
  });

  it('as migrations anteriores continuam intactas (nenhuma mexe em audit_events nem nos papéis novos)', () => {
    for (const file of migrationFiles()) {
      if (
        file.name.endsWith('_rbac_audit') ||
        file.name.endsWith('_channel_connections') ||
        file.name.endsWith('_rename_company_membership') ||
        file.name.endsWith('_company_invitations')
      ) {
        continue;
      }
      // Palavra inteira: a trilha da plataforma (spec 044, `platform_audit_events`) é outra tabela.
      assert.doesNotMatch(file.sql, /\baudit_events\b|\baudit_action\b|'VIEWER'/);
    }
  });
});

describe('migration da spec 015 (conexão do canal)', () => {
  const migration = migrationFiles().find((file) => file.name.endsWith('_channel_connections'));

  it('é aditiva: tabela nova, ações novas e alvo anulável; nada apagado nem reescrito', () => {
    assert.ok(migration !== undefined, 'migration _channel_connections existe');
    const statements = migration.sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    // `DROP NOT NULL` só relaxa a coluna (aditivo); apagar tabela, coluna, tipo ou índice não.
    for (const forbidden of [
      /\bDROP\s+(TABLE|COLUMN|TYPE|INDEX|CONSTRAINT|DEFAULT)\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bTRUNCATE\b/i,
      /\bRENAME\b/i,
    ]) {
      assert.doesNotMatch(statements, forbidden);
    }
    assert.match(statements, /CREATE TABLE "channel_connections"/);
    assert.match(statements, /CREATE UNIQUE INDEX "channel_connections_client_id_key"/);
    assert.match(statements, /ADD VALUE IF NOT EXISTS 'CHANNEL_CONNECTED'/);
    assert.match(statements, /ALTER COLUMN "target_user_id" DROP NOT NULL/);
    assert.match(statements, /audit_events_target_by_action_check/);
    // Nenhum token é cifrado (nem tocado) pela migration.
    assert.doesNotMatch(statements, /UPDATE\s+"clients"|whatsapp_phone_number_id/);
  });
});

describe('migration da spec 022 (renome do domínio)', () => {
  const migration = migrationFiles().find((file) =>
    file.name.endsWith('_rename_company_membership'),
  );
  const statements = (migration?.sql ?? '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  it('só renomeia (metadado): nenhum dado é apagado, nenhuma tabela é recriada, sem BEGIN/COMMIT próprios', () => {
    assert.ok(migration !== undefined, 'migration _rename_company_membership existe');
    for (const forbidden of [
      /\bDELETE\s+FROM\b/i,
      /\bTRUNCATE\b/i,
      /\bDROP\s+(TABLE|COLUMN|TYPE|INDEX)\b/i,
      /\bCREATE\s+(TABLE|TYPE|INDEX|UNIQUE)\b/i,
      /\bALTER\s+COLUMN\b/i,
      /\b(UPDATE|INSERT\s+INTO)\b/i,
      /^\s*(BEGIN|COMMIT)\s*;/im,
    ]) {
      assert.doesNotMatch(statements, forbidden);
    }
  });

  it('a única constraint removida é o CHECK por ação, recriado com o prefixo novo', () => {
    const drops = statements.match(/DROP\s+CONSTRAINT\s+\w+/gi) ?? [];
    assert.deepEqual(drops, ['DROP CONSTRAINT audit_events_target_by_action_check']);
    assert.match(statements, /ADD CONSTRAINT audit_events_target_by_action_check CHECK/);
    assert.ok(statements.includes("LIKE 'MEMBERSHIP\\_%' AND target_membership_id IS NOT NULL"));
    assert.ok(statements.includes("LIKE 'CHANNEL\\_%' AND target_membership_id IS NULL"));
  });

  it('as chaves estrangeiras compostas e os únicos (id, company_id) são renomeados, não recriados', () => {
    assert.doesNotMatch(statements, /FOREIGN KEY/i);
    assert.doesNotMatch(statements, /ADD CONSTRAINT\s+\w+_fkey/i);
    for (const name of [
      'messages_conversation_id_company_id_fkey',
      'messages_reply_to_id_company_id_fkey',
      'messages_answered_by_id_company_id_fkey',
      'audit_events_actor_membership_id_company_id_fkey',
      'audit_events_target_membership_id_company_id_fkey',
    ]) {
      assert.match(statements, new RegExp(`RENAME CONSTRAINT \\w+ TO ${name};`));
    }
    for (const name of [
      'conversations_id_company_id_key',
      'messages_id_company_id_key',
      'memberships_id_company_id_key',
    ]) {
      assert.match(statements, new RegExp(`ALTER INDEX \\w+ RENAME TO ${name};`));
    }
  });

  it('termina com a verificação que recusa qualquer nome antigo que sobrar', () => {
    assert.match(statements, /RAISE EXCEPTION 'RENAME_LEFTOVERS/);
  });
});

describe('migration da spec 025 (convites por e-mail)', () => {
  const migration = migrationFiles().find((file) => file.name.endsWith('_company_invitations'));
  const statements = (migration?.sql ?? '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  it('é aditiva: nada é apagado nem reescrito além do CHECK por ação recriado', () => {
    assert.ok(migration !== undefined, 'migration _company_invitations existe');
    for (const forbidden of [
      /\bDROP\s+(TABLE|COLUMN|TYPE|INDEX|DEFAULT)\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bTRUNCATE\b/i,
      /\bRENAME\b/i,
      /\bUPDATE\s+"/i,
    ]) {
      assert.doesNotMatch(statements, forbidden);
    }
    // O único DROP é o do CHECK por ação, recriado na mesma migration.
    assert.deepEqual(statements.match(/DROP CONSTRAINT "[a-z_]+"/g), [
      'DROP CONSTRAINT "audit_events_target_by_action_check"',
    ]);
    assert.match(statements, /CREATE TABLE "company_invitations"/);
    assert.match(statements, /ADD COLUMN "invitation_id" UUID/);
  });

  it('usa os valores novos de audit_action só pelo texto (valor de enum novo não vale na mesma transação)', () => {
    assert.match(statements, /ADD VALUE IF NOT EXISTS 'INVITATION_ACCEPTED'/);
    assert.match(statements, /"action"::text IN \('INVITATION_CREATED'/);
    assert.doesNotMatch(statements, /'INVITATION_[A-Z]+'::"?audit_action/);
  });

  it('guarda e-mail e hash só em convite PENDING, bloqueia OWNER e usa chaves compostas', () => {
    assert.match(statements, /company_invitations_state_check/);
    assert.match(statements, /company_invitations_role_check" CHECK \("role" <> 'OWNER'\)/);
    assert.match(statements, /WHERE "status" = 'PENDING'/);
    for (const column of ['invited_by_membership_id', 'accepted_membership_id']) {
      assert.match(
        statements,
        new RegExp(`FOREIGN KEY \\("${column}", "company_id"\\) REFERENCES "memberships"`),
      );
    }
    assert.match(
      statements,
      /FOREIGN KEY \("invitation_id", "company_id"\) REFERENCES "company_invitations"/,
    );
  });
});

describe('migration da spec 044 (segundo fator e trilha da plataforma)', () => {
  const migration = migrationFiles().find((file) =>
    file.name.endsWith('_platform_admin_second_factor'),
  );
  const statements = (migration?.sql ?? '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  it('é aditiva: colunas anuláveis, tipos e tabela novos; nada apagado, renomeado nem reescrito', () => {
    assert.ok(migration !== undefined, 'migration _platform_admin_second_factor existe');
    for (const forbidden of [
      /\bDROP\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bTRUNCATE\b/i,
      /\bRENAME\b/i,
      /\bUPDATE\s+"/i,
      /SET NOT NULL/i,
      /ALTER COLUMN/i,
    ]) {
      assert.doesNotMatch(statements, forbidden);
    }
    assert.match(statements, /ADD COLUMN\s+"totp_last_step" INTEGER,/);
    assert.match(statements, /ADD COLUMN\s+"totp_secret_ciphertext" TEXT;/);
    assert.match(statements, /CREATE TABLE "platform_audit_events"/);
    // A trilha não segura o expurgo de contas (spec 021): o sujeito vira nulo.
    assert.match(
      statements,
      /"subject_account_id"\) REFERENCES "accounts"\("id"\) ON DELETE SET NULL/,
    );
    assert.match(
      statements,
      /"admin_id"\) REFERENCES "platform_admins"\("id"\) ON DELETE RESTRICT/,
    );
    // Sem coluna company_id: a trilha é global (MODEL_SCOPES) e não entra no escopo de tenant.
    assert.doesNotMatch(statements, /"company_id"/);
  });
});

describe('migration da spec 045, E2 (ações sobre contas na trilha da plataforma)', () => {
  const migration = migrationFiles().find((file) =>
    file.name.endsWith('_platform_account_actions'),
  );
  const statements = (migration?.sql ?? '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  it('é aditiva: só valores novos no enum da trilha, nada apagado, renomeado nem reescrito', () => {
    assert.ok(migration !== undefined, 'migration _platform_account_actions existe');
    for (const forbidden of [
      /\bDROP\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bTRUNCATE\b/i,
      /\bRENAME\b/i,
      /\bUPDATE\b/i,
      /SET NOT NULL/i,
      /ALTER COLUMN/i,
      /ALTER TABLE/i,
    ]) {
      assert.doesNotMatch(statements, forbidden);
    }
    const added = [
      ...statements.matchAll(
        /ALTER TYPE "platform_audit_action" ADD VALUE IF NOT EXISTS '(\w+)';/g,
      ),
    ].map((match) => match[1]);
    assert.deepEqual(added, [
      'ACCOUNT_DISABLED',
      'ACCOUNT_ENABLED',
      'ACCOUNT_SESSIONS_REVOKED',
      'ACCOUNT_PASSWORD_RESET_SENT',
      'ACCOUNT_VERIFICATION_SENT',
    ]);
    assert.equal(
      statements
        .trim()
        .split(';')
        .filter((s) => s.trim() !== '').length,
      5,
    );
  });
});
