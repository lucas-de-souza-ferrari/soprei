import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { MODEL_SCOPES } from './extensions/tenant-scope.js';

// Spec 027 (E1): a migration aplica sobre o schema anterior, cria os enums, as cinco tabelas, as chaves
// estrangeiras compostas, os CHECKs e a restrição de exclusão. Roda num schema temporário dentro de uma
// transação que sempre sofre rollback: nada compartilhado é alterado. O `CREATE EXTENSION IF NOT EXISTS
// btree_gist` da migration é um no-op quando a extensão já existe (no `public` do banco de testes); o
// `search_path` do teste inclui `public` para os operadores dela.
const config = loadIntegrationConfig();

test('migration da 027 aplica sobre o schema anterior e impõe a restrição de exclusão, FKs compostas e CHECKs', async () => {
  const sql = await readFile(
    new URL(
      '../../../prisma/migrations/20261105100000_schedule_appointments/migration.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(sql, /CREATE EXTENSION IF NOT EXISTS btree_gist/);
  const schema = `soprei_migration_${randomUUID().replaceAll('-', '')}`;
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  const companyA = randomUUID();
  const companyB = randomUUID();
  const memberA = randomUUID();
  const memberB = randomUUID();
  const code = async (statement: string, values: unknown[] = []): Promise<string | null> => {
    await client.query('SAVEPOINT attempt');
    try {
      await client.query(statement, values);
      await client.query('RELEASE SAVEPOINT attempt');
      return null;
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT attempt');
      return (error as { code?: string }).code ?? 'unknown';
    }
  };
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
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

    const extension = await client.query(`SELECT 1 FROM pg_extension WHERE extname = 'btree_gist'`);
    assert.equal(extension.rows.length, 1);
    const exclusion = await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
        WHERE c.conname = 'appointments_no_overlap' AND c.contype = 'x' AND c.connamespace = $1::regnamespace`,
      [schema],
    );
    assert.match(
      exclusion.rows[0]?.def ?? '',
      /EXCLUDE USING gist \(resource_id WITH =, tstzrange\(starts_at, blocked_until, '\[\)'::text\) WITH &&\)/,
    );
    assert.match(exclusion.rows[0]?.def ?? '', /status = ANY|status IN|PENDING/);
    const statuses = await client.query<{ enumlabel: string }>(
      `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'appointment_status' AND t.typnamespace = $1::regnamespace ORDER BY e.enumsortorder`,
      [schema],
    );
    assert.deepEqual(
      statuses.rows.map((row) => row.enumlabel),
      ['PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW'],
    );

    const resourceA = randomUUID();
    const resourceB = randomUUID();
    const serviceA = randomUUID();
    const serviceB = randomUUID();
    await client.query(
      `INSERT INTO schedule_resources (id, company_id, name, updated_at) VALUES ($1, $3, 'R', now()), ($2, $4, 'R', now())`,
      [resourceA, resourceB, companyA, companyB],
    );
    await client.query(
      `INSERT INTO schedule_services (id, company_id, name, duration_minutes, updated_at) VALUES ($1, $3, 'S', 30, now()), ($2, $4, 'S', 30, now())`,
      [serviceA, serviceB, companyA, companyB],
    );
    const insert = (
      company: string,
      resource: string,
      service: string | null,
      member: string | null,
      starts: string,
      ends: string,
      kind = 'BOOKING',
      source = 'PANEL',
    ) =>
      client.query(
        `INSERT INTO appointments (id, company_id, resource_id, service_id, kind, status, starts_at, ends_at, blocked_until,
                                   source, created_by_membership_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'CONFIRMED', $6, $7, $7, $8, $9, now())`,
        [randomUUID(), company, resource, service, kind, starts, ends, source, member],
      );
    await insert(
      companyA,
      resourceA,
      serviceA,
      memberA,
      '2026-12-01T10:00:00Z',
      '2026-12-01T10:30:00Z',
    );
    // Adjacente passa; sobreposto é 23P01; em outro recurso (de outra empresa) passa.
    await insert(
      companyA,
      resourceA,
      serviceA,
      memberA,
      '2026-12-01T10:30:00Z',
      '2026-12-01T11:00:00Z',
    );
    await insert(
      companyB,
      resourceB,
      serviceB,
      memberB,
      '2026-12-01T10:00:00Z',
      '2026-12-01T10:30:00Z',
    );
    assert.equal(
      await code(
        `INSERT INTO appointments (id, company_id, resource_id, service_id, kind, status, starts_at, ends_at, blocked_until, source, created_by_membership_id, updated_at)
         VALUES ($1, $2, $3, $4, 'BOOKING', 'PENDING', '2026-12-01T10:15:00Z', '2026-12-01T10:45:00Z', '2026-12-01T10:45:00Z', 'PANEL', $5, now())`,
        [randomUUID(), companyA, resourceA, serviceA, memberA],
      ),
      '23P01',
    );
    // FKs compostas.
    for (const [resource, service, member] of [
      [resourceB, serviceA, memberA],
      [resourceA, serviceB, memberA],
      [resourceA, serviceA, memberB],
    ] as const) {
      assert.equal(
        await code(
          `INSERT INTO appointments (id, company_id, resource_id, service_id, kind, status, starts_at, ends_at, blocked_until, source, created_by_membership_id, updated_at)
           VALUES ($1, $2, $3, $4, 'BOOKING', 'CONFIRMED', '2026-12-05T10:00:00Z', '2026-12-05T10:30:00Z', '2026-12-05T10:30:00Z', 'PANEL', $5, now())`,
          [randomUUID(), companyA, resource, service, member],
        ),
        '23503',
      );
    }
    // CHECKs.
    assert.equal(
      await code(
        `INSERT INTO appointments (id, company_id, resource_id, service_id, kind, status, starts_at, ends_at, blocked_until, source, created_by_membership_id, updated_at)
         VALUES ($1, $2, $3, $4, 'BOOKING', 'CONFIRMED', '2026-12-06T10:30:00Z', '2026-12-06T10:00:00Z', '2026-12-06T10:30:00Z', 'PANEL', $5, now())`,
        [randomUUID(), companyA, resourceA, serviceA, memberA],
      ),
      '23514',
    );
    assert.equal(
      await code(
        `INSERT INTO appointments (id, company_id, resource_id, service_id, kind, status, starts_at, ends_at, blocked_until, source, created_by_membership_id, updated_at)
         VALUES ($1, $2, $3, $4, 'BLOCK', 'CONFIRMED', '2026-12-07T10:00:00Z', '2026-12-07T10:30:00Z', '2026-12-07T10:30:00Z', 'PANEL', $5, now())`,
        [randomUUID(), companyA, resourceA, serviceA, memberA],
      ),
      '23514',
    );
    // Canal sem autor é aceito; painel sem autor é recusado; cancelado exige cancelled_at.
    await insert(
      companyA,
      resourceA,
      serviceA,
      null,
      '2026-12-08T10:00:00Z',
      '2026-12-08T10:30:00Z',
      'BOOKING',
      'CHANNEL',
    );
    assert.equal(
      await code(
        `INSERT INTO appointments (id, company_id, resource_id, service_id, kind, status, starts_at, ends_at, blocked_until, source, updated_at)
         VALUES ($1, $2, $3, $4, 'BOOKING', 'CONFIRMED', '2026-12-09T10:00:00Z', '2026-12-09T10:30:00Z', '2026-12-09T10:30:00Z', 'PANEL', now())`,
        [randomUUID(), companyA, resourceA, serviceA],
      ),
      '23514',
    );
    assert.equal(
      await code(
        `INSERT INTO appointments (id, company_id, resource_id, service_id, kind, status, starts_at, ends_at, blocked_until, source, created_by_membership_id, updated_at)
         VALUES ($1, $2, $3, $4, 'BOOKING', 'CANCELLED', '2026-12-10T10:00:00Z', '2026-12-10T10:30:00Z', '2026-12-10T10:30:00Z', 'PANEL', $5, now())`,
        [randomUUID(), companyA, resourceA, serviceA, memberA],
      ),
      '23514',
    );
    // Regras, serviço, recurso, configurações.
    assert.equal(
      await code(
        `INSERT INTO availability_rules (id, company_id, resource_id, weekday, start_minute, end_minute) VALUES ($1, $2, $3, 8, 0, 60)`,
        [randomUUID(), companyA, resourceA],
      ),
      '23514',
    );
    assert.equal(
      await code(
        `INSERT INTO availability_rules (id, company_id, resource_id, weekday, start_minute, end_minute) VALUES ($1, $2, $3, 1, 600, 600)`,
        [randomUUID(), companyA, resourceA],
      ),
      '23514',
    );
    assert.equal(
      await code(
        `INSERT INTO availability_rules (id, company_id, resource_id, weekday, start_minute, end_minute) VALUES ($1, $2, $3, 1, 0, 1441)`,
        [randomUUID(), companyA, resourceA],
      ),
      '23514',
    );
    assert.equal(
      await code(
        `INSERT INTO availability_rules (id, company_id, resource_id, weekday, start_minute, end_minute) VALUES ($1, $2, $3, 1, 0, 60)`,
        [randomUUID(), companyA, resourceB],
      ),
      '23503',
    );
    assert.equal(
      await code(
        `INSERT INTO schedule_services (id, company_id, name, duration_minutes, updated_at) VALUES ($1, $2, 'X', 33, now())`,
        [randomUUID(), companyA],
      ),
      '23514',
    );
    await client.query(
      `INSERT INTO schedule_settings (id, company_id, updated_at) VALUES ($1, $2, now())`,
      [randomUUID(), companyA],
    );
    assert.equal(
      await code(
        `INSERT INTO schedule_settings (id, company_id, updated_at) VALUES ($1, $2, now())`,
        [randomUUID(), companyA],
      ),
      '23505',
    );
    assert.equal(
      await code(
        `INSERT INTO schedule_settings (id, company_id, slot_step_minutes, updated_at) VALUES ($1, $2, 25, now())`,
        [randomUUID(), companyB],
      ),
      '23514',
    );
    // Recurso e serviço com agendamento não são apagados (RESTRICT).
    assert.equal(await code('DELETE FROM schedule_resources WHERE id = $1', [resourceA]), '23001');
    assert.equal(await code('DELETE FROM schedule_services WHERE id = $1', [serviceA]), '23001');
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});

test('os models novos da 027 estão classificados como tenant', () => {
  for (const model of [
    'ScheduleSettings',
    'ScheduleResource',
    'ScheduleService',
    'AvailabilityRule',
    'Appointment',
  ] as const) {
    assert.equal(MODEL_SCOPES[model], 'tenant');
  }
});
