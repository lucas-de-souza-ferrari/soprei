import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { MODEL_SCOPES } from './extensions/tenant-scope.js';

// Spec 026 (E1): a migration aplica sobre o schema anterior, cria as tabelas, o índice GIN de expressão,
// as chaves estrangeiras compostas e os CHECKs. Roda num schema temporário dentro de uma transação
// que sempre sofre rollback: nada compartilhado é alterado.
const config = loadIntegrationConfig();

test('migration da 026 (E1) aplica sobre o schema anterior e impõe índices, FKs compostas e CHECKs', async () => {
  const sql = await readFile(
    new URL(
      '../../../prisma/migrations/20261104210000_knowledge_documents/migration.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const schema = `soprei_migration_${randomUUID().replaceAll('-', '')}`;
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  const companyA = randomUUID();
  const companyB = randomUUID();
  const memberA = randomUUID();
  const memberB = randomUUID();
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
    // Pré-requisitos como estavam depois da 025 (só o que a migration toca).
    await client.query('CREATE TABLE companies (id uuid PRIMARY KEY)');
    await client.query(`CREATE TABLE memberships (
      id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), email text NOT NULL)`);
    await client.query(
      'CREATE UNIQUE INDEX memberships_id_company_id_key ON memberships (id, company_id)',
    );
    await client.query('INSERT INTO companies (id) VALUES ($1), ($2)', [companyA, companyB]);
    await client.query(
      `INSERT INTO memberships (id, company_id, email) VALUES ($1, $3, 'a@x.test'), ($2, $4, 'b@x.test')`,
      [memberA, memberB, companyA, companyB],
    );

    await client.query(sql);

    const tables = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY 1`,
      [schema],
    );
    assert.ok(
      ['knowledge_chunks', 'knowledge_documents'].every((name) =>
        tables.rows.some((row) => row.tablename === name),
      ),
    );
    const gin = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'knowledge_chunks_search_idx'`,
      [schema],
    );
    assert.match(
      gin.rows[0]?.indexdef ?? '',
      /USING gin \(to_tsvector\('portuguese'::regconfig, search_text\)\)/,
    );

    const documentId = randomUUID();
    const insertDocument = (id: string, company: string, member: string, title = 'Doc') =>
      client.query(
        `INSERT INTO knowledge_documents (id, company_id, title, char_count, chunk_count, preview, created_by_membership_id)
         VALUES ($1, $2, $3, 10, 1, 'p', $4)`,
        [id, company, title, member],
      );
    await insertDocument(documentId, companyA, memberA);
    await client.query(
      `INSERT INTO knowledge_chunks (id, company_id, document_id, position, content, search_text)
       VALUES ($1, $2, $3, 0, 'conteúdo', 'conteúdo conteudo')`,
      [randomUUID(), companyA, documentId],
    );

    // Chaves estrangeiras compostas: nada se liga a dado de outra empresa.
    assert.equal(
      await refused(
        `INSERT INTO knowledge_chunks (id, company_id, document_id, position, content, search_text)
         VALUES ($1, $2, $3, 1, 'x', 'x')`,
        [randomUUID(), companyB, documentId],
      ),
      true,
    );
    assert.equal(await refused(`SELECT 1 WHERE false`), false);
    assert.equal(
      await refused(
        'INSERT INTO knowledge_documents (id, company_id, title, char_count, chunk_count, preview, created_by_membership_id) VALUES ($1, $2, $3, 1, 1, $4, $5)',
        [randomUUID(), companyA, 'x', 'p', memberB],
      ),
      true,
    );
    // CHECKs de tamanho.
    assert.equal(
      await refused(`UPDATE knowledge_documents SET title = '' WHERE id = $1`, [documentId]),
      true,
    );
    assert.equal(
      await refused(`UPDATE knowledge_documents SET chunk_count = 151 WHERE id = $1`, [documentId]),
      true,
    );
    assert.equal(
      await refused(`UPDATE knowledge_documents SET char_count = 100001 WHERE id = $1`, [
        documentId,
      ]),
      true,
    );
    assert.equal(
      await refused(`UPDATE knowledge_chunks SET search_text = '' WHERE document_id = $1`, [
        documentId,
      ]),
      true,
    );

    // Cascata: apagar o documento apaga os trechos.
    await client.query('DELETE FROM knowledge_documents WHERE id = $1', [documentId]);
    const left = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM knowledge_chunks',
    );
    assert.equal(left.rows[0]?.count, '0');
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});

test('os models novos da 026 estão classificados como tenant', () => {
  assert.equal(MODEL_SCOPES.KnowledgeDocument, 'tenant');
  assert.equal(MODEL_SCOPES.KnowledgeChunk, 'tenant');
});
