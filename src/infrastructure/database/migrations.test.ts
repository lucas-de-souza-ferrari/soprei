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
      if (file.name.endsWith('_rbac_audit') || file.name.endsWith('_channel_connections')) continue;
      assert.doesNotMatch(file.sql, /audit_events|audit_action|'VIEWER'/);
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
