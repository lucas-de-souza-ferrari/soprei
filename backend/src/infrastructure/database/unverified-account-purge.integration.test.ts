import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import {
  createDatabase,
  PrismaAccountRepository,
  PrismaUnverifiedAccountPurgeRepository,
} from './index.js';

const config = loadIntegrationConfig();
// As contas do teste ficam em 2000 e o corte em 2001: nenhuma conta de outro teste (criada agora)
// nem do dono entra na varredura.
const OLD = '2000-01-01T00:00:00Z';
const CUTOFF = new Date('2001-01-01T00:00:00Z');
const RECENT = '2002-01-01T00:00:00Z';
const T0 = new Date('2026-11-03T12:00:00.000Z');

async function withPurge(
  body: (ctx: {
    purge: PrismaUnverifiedAccountPurgeRepository;
    repo: PrismaAccountRepository;
    sql: pg.Client;
    prisma: ReturnType<typeof createDatabase>['prisma'];
    tenants: TestTenants;
    /** Cria conta direto no banco com `updated_at` escolhido. */
    insert: (options: { updatedAt: string; verified?: boolean; hash?: string }) => Promise<{
      id: string;
      email: string;
    }>;
    exists: (id: string) => Promise<boolean>;
  }) => Promise<void>,
): Promise<void> {
  const logs = captureLogs();
  const db = createDatabase(config, logs.logger);
  const sql = new pg.Client({ connectionString: config.DATABASE_URL });
  await sql.connect();
  const tenants = new TestTenants(db.prisma);
  const ids: string[] = [];
  const insert = async (options: { updatedAt: string; verified?: boolean; hash?: string }) => {
    const id = randomUUID();
    const email = `purga-${id}@example.test`;
    await sql.query(
      `INSERT INTO accounts (id, email, password_hash, email_verified_at, verification_hash,
                             verification_expires_at, updated_at)
       VALUES ($1, $2, 'hash', $3, $4, $5, $6)`,
      [
        id,
        email,
        options.verified ? OLD : null,
        options.hash ?? null,
        options.hash === undefined ? null : '2999-01-01T00:00:00Z',
        options.updatedAt,
      ],
    );
    ids.push(id);
    return { id, email };
  };
  const exists = async (id: string): Promise<boolean> =>
    (await sql.query('SELECT 1 FROM accounts WHERE id = $1', [id])).rowCount === 1;
  try {
    await body({
      purge: new PrismaUnverifiedAccountPurgeRepository(db.prisma),
      repo: new PrismaAccountRepository(db.prisma),
      sql,
      prisma: db.prisma,
      tenants,
      insert,
      exists,
    });
  } finally {
    await tenants.cleanup();
    await sql.query('DELETE FROM users WHERE account_id = ANY($1::uuid[])', [ids]);
    await sql.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [ids]);
    await sql.end();
    await db.close();
  }
}

test('apaga só conta não confirmada, sem vínculo e antiga; respeita o tamanho do lote', async () => {
  await withPurge(async ({ purge, insert, exists, prisma, tenants }) => {
    const stale = await insert({ updatedAt: OLD });
    const recent = await insert({ updatedAt: RECENT });
    const confirmedOld = await insert({ updatedAt: OLD, verified: true });
    const withMember = await insert({ updatedAt: OLD });
    // Mesmo forçando o estado (conta não confirmada com vínculo), a conta não é apagada.
    const client = await tenants.createClient('purga');
    await prisma.user.create({
      data: {
        clientId: client.id,
        accountId: withMember.id,
        email: withMember.email,
        passwordHash: 'account-managed',
        role: 'OWNER',
      },
    });
    assert.equal(await purge.purgeUnverified(CUTOFF, 100), 1);
    assert.equal(await exists(stale.id), false);
    assert.equal(await exists(recent.id), true);
    assert.equal(await exists(confirmedOld.id), true);
    assert.equal(await exists(withMember.id), true);
    // Nada a fazer: execução vazia.
    assert.equal(await purge.purgeUnverified(CUTOFF, 100), 0);
    // Cliente e usuário do vínculo continuam intactos.
    assert.equal(await prisma.user.count({ where: { clientId: client.id } }), 1);

    const batch = [await insert({ updatedAt: OLD }), await insert({ updatedAt: OLD })];
    batch.push(await insert({ updatedAt: OLD }));
    assert.equal(await purge.purgeUnverified(CUTOFF, 2), 2);
    const left = (await Promise.all(batch.map((account) => exists(account.id)))).filter(Boolean);
    assert.equal(left.length, 1);
    assert.equal(await purge.purgeUnverified(CUTOFF, 2), 1);
  });
});

test('corrida entre confirmar e expurgar: nunca "confirmada e apagada"; conta confirmada nunca some', async () => {
  await withPurge(async ({ purge, repo, insert, exists, sql }) => {
    let purgedWins = 0;
    let verifyWins = 0;
    for (let round = 0; round < 12; round += 1) {
      const account = await insert({ updatedAt: OLD, hash: 'codigo-hmac' });
      const [outcome, deleted] = await Promise.all([
        repo.verify(account.id, 'codigo-hmac', T0),
        purge.purgeUnverified(CUTOFF, 100),
      ]);
      const stillThere = await exists(account.id);
      if (outcome === 'verified') {
        verifyWins += 1;
        assert.equal(stillThere, true, `rodada ${round}: confirmada e apagada`);
        const row = await sql.query<{ email_verified_at: Date | null }>(
          'SELECT email_verified_at FROM accounts WHERE id = $1',
          [account.id],
        );
        assert.ok(row.rows[0]?.email_verified_at);
        assert.equal(deleted, 0);
      } else {
        purgedWins += 1;
        // O expurgo venceu: a linha sumiu e a confirmação respondeu "indisponível" (401 uniforme).
        assert.equal(outcome, 'unavailable');
        assert.equal(stillThere, false);
        assert.equal(deleted, 1);
      }
    }
    assert.equal(purgedWins + verifyWins, 12);
  });
});

test('depois do expurgo o mesmo e-mail se cadastra de novo com id novo', async () => {
  await withPurge(async ({ purge, repo, insert, exists }) => {
    const stale = await insert({ updatedAt: OLD, hash: 'codigo-antigo' });
    assert.equal(await purge.purgeUnverified(CUTOFF, 100), 1);
    assert.equal(await exists(stale.id), false);
    const novo = randomUUID();
    const id = await repo.registerUnverified({
      id: novo,
      email: stale.email,
      passwordHash: 'hash-novo',
      verificationHash: 'codigo-novo',
      expiresAt: new Date(T0.getTime() + 15 * 60_000),
      retryBefore: new Date(T0.getTime() + 14 * 60_000),
      now: T0,
    });
    assert.equal(id, novo);
    assert.notEqual(id, stale.id);
    await repo.verify(novo, 'codigo-novo', T0);
  });
});
