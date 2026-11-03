import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import {
  runPasswordResetContract,
  type ResetState,
} from '../../test-support/account-repository-contract.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { createDatabase, PrismaAccountRepository } from './index.js';

const config = loadIntegrationConfig();
const T0 = new Date('2026-11-03T12:00:00.000Z');
const TTL = 15 * 60_000;
const GAP = 60_000;
const at = (ms: number): Date => new Date(T0.getTime() + ms);

async function withRepository(
  body: (ctx: {
    repo: PrismaAccountRepository;
    newEmail: () => string;
    state: (email: string) => Promise<ResetState>;
    /** Conta confirmada com um código de recuperação vigente (hash informado). */
    seed: (hash: string) => Promise<{ id: string; email: string }>;
    prisma: ReturnType<typeof createDatabase>['prisma'];
  }) => Promise<void>,
): Promise<void> {
  const logs = captureLogs();
  const db = createDatabase(config, logs.logger);
  const repo = new PrismaAccountRepository(db.prisma);
  const emails: string[] = [];
  const newEmail = (): string => {
    const email = `reset-${randomUUID()}@example.test`;
    emails.push(email);
    return email;
  };
  const state = async (email: string): Promise<ResetState> => {
    const row = await db.prisma.account.findUnique({ where: { email } });
    assert.ok(row);
    return {
      hash: row.resetHash,
      expiresAt: row.resetExpiresAt,
      attempts: row.resetAttempts,
      failuresDay: row.resetFailuresDay,
      failuresSince: row.resetFailuresSince,
      passwordHash: row.passwordHash,
    };
  };
  const seed = async (hash: string): Promise<{ id: string; email: string }> => {
    const email = newEmail();
    const row = await db.prisma.account.create({
      data: {
        email,
        passwordHash: 'senha-antiga',
        emailVerifiedAt: T0,
        resetHash: hash,
        resetExpiresAt: at(TTL),
      },
    });
    return { id: row.id, email };
  };
  try {
    await body({ repo, newEmail, state, seed, prisma: db.prisma });
  } finally {
    await db.prisma.account.deleteMany({ where: { email: { in: emails } } });
    await db.close();
  }
}

test('contrato da recuperação de senha no Postgres real (spec 021)', async () => {
  await withRepository(async ({ repo, newEmail, state }) => {
    await runPasswordResetContract({ repo, resetState: state }, newEmail);
  });
});

test('50 erros simultâneos no mesmo código dão exatamente 5 incrementos e nenhum seguinte casa', async () => {
  await withRepository(async ({ repo, state, seed }) => {
    const { email } = await seed('hash-correto');
    const results = await Promise.all(
      Array.from({ length: 50 }, () => repo.recordResetFailure(email, at(1000))),
    );
    const count = (outcome: string): number => results.filter((r) => r === outcome).length;
    assert.equal(count('wrong'), 4);
    assert.equal(count('exhausted'), 1);
    assert.equal(count('unavailable'), 45);
    const row = await state(email);
    assert.equal(row.attempts, 5);
    assert.equal(row.hash, null);
    assert.equal(row.failuresDay, 5);
    // O código certo depois do 5º erro não troca a senha.
    assert.equal(await repo.resetPassword(email, 'hash-correto', 'nova', at(2000)), false);
    assert.equal((await state(email)).passwordHash, 'senha-antiga');
  });
});

test('20 erros simultâneos e 1 certa: a certa só vale antes do 5º erro; attempts nunca passa de 5', async () => {
  await withRepository(async ({ repo, state, seed }) => {
    for (let round = 0; round < 7; round += 1) {
      const { email } = await seed('hash-correto');
      const position = round * 3;
      const results = await Promise.all(
        Array.from({ length: 21 }, (_, i) =>
          i === position
            ? repo.resetPassword(email, 'hash-correto', 'nova', at(1000))
            : repo.recordResetFailure(email, at(1000)),
        ),
      );
      const changed = results.filter((r) => r === true).length;
      const row = await state(email);
      assert.ok(row.attempts <= 5, `rodada ${round}: attempts ${row.attempts}`);
      assert.ok(changed <= 1);
      if (changed === 1) {
        assert.equal(row.passwordHash, 'nova', `rodada ${round}`);
        assert.equal(row.hash, null);
        assert.equal(row.attempts, 0);
      } else {
        assert.equal(row.passwordHash, 'senha-antiga', `rodada ${round}`);
        assert.equal(row.attempts, 5);
        assert.equal(row.hash, null);
      }
    }
  });
});

test('dois resets simultâneos com o mesmo código certo: exatamente um vence e a senha final é a dele', async () => {
  await withRepository(async ({ repo, state, seed }) => {
    for (let round = 0; round < 5; round += 1) {
      const { email } = await seed('hash-correto');
      const [a, b] = await Promise.all([
        repo.resetPassword(email, 'hash-correto', 'senha-a', at(1000)),
        repo.resetPassword(email, 'hash-correto', 'senha-b', at(1000)),
      ]);
      assert.equal([a, b].filter(Boolean).length, 1, `rodada ${round}`);
      assert.equal((await state(email)).passwordHash, a ? 'senha-a' : 'senha-b');
      assert.equal((await state(email)).hash, null);
    }
  });
});

test('o teto diário vale sob concorrência: erros simultâneos em códigos novos nunca passam de 10 no dia', async () => {
  await withRepository(async ({ repo, state, seed }) => {
    const { email, id } = await seed('hash-0');
    const results: string[] = [];
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const start = cycle * 61_000;
      if (cycle > 0) {
        const issued = await repo.issueResetCode(
          email,
          `hash-${cycle}`,
          at(start + TTL),
          at(start + TTL - GAP),
          at(start),
        );
        // Depois de 10 erros no dia, nenhum código novo.
        assert.equal(issued, cycle < 2 ? id : null, `ciclo ${cycle}`);
      }
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () => repo.recordResetFailure(email, at(start + 1000))),
      );
      results.push(...outcomes.filter((o) => o !== 'unavailable'));
    }
    const row = await state(email);
    assert.equal(row.failuresDay, 10);
    assert.equal(row.hash, null);
    assert.equal(results.length, 10);
  });
});

test('pedidos simultâneos gravam no máximo um código por intervalo', async () => {
  await withRepository(async ({ repo, state, newEmail }) => {
    const email = newEmail();
    await repo.registerUnverified({
      id: randomUUID(),
      email,
      passwordHash: 'senha-antiga',
      verificationHash: 'v',
      expiresAt: at(TTL),
      retryBefore: at(TTL - GAP),
      now: at(0),
    });
    assert.equal(
      await repo.verify((await repo.findByEmail(email))?.id ?? '', 'v', at(1)),
      'verified',
    );
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        repo.issueResetCode(email, `hash-${i}`, at(TTL + 1000), at(TTL - GAP + 1000), at(1000)),
      ),
    );
    assert.equal(results.filter((r) => r !== null).length, 1);
    const row = await state(email);
    assert.match(row.hash ?? '', /^hash-\d+$/);
    assert.equal(row.expiresAt?.getTime(), at(TTL + 1000).getTime());
  });
});

test('conta desativada ou com e-mail não confirmado nunca redefine, nem com código forjado no banco', async () => {
  await withRepository(async ({ repo, state, seed, prisma }) => {
    const disabled = await seed('hash-correto');
    await prisma.account.update({ where: { id: disabled.id }, data: { status: 'DISABLED' } });
    assert.equal(await repo.resetPassword(disabled.email, 'hash-correto', 'nova', at(1000)), false);
    assert.equal(await repo.hasValidResetCode(disabled.email, 'hash-correto', at(1000)), false);
    assert.equal(await repo.recordResetFailure(disabled.email, at(1000)), 'unavailable');
    assert.equal(await repo.issueResetCode(disabled.email, 'novo', at(TTL), at(0), at(1000)), null);
    assert.equal((await state(disabled.email)).passwordHash, 'senha-antiga');

    const unconfirmed = await seed('hash-correto');
    await prisma.account.update({ where: { id: unconfirmed.id }, data: { emailVerifiedAt: null } });
    assert.equal(
      await repo.resetPassword(unconfirmed.email, 'hash-correto', 'nova', at(1000)),
      false,
    );
    assert.equal(await repo.hasValidResetCode(unconfirmed.email, 'hash-correto', at(1000)), false);
    assert.equal(await repo.recordResetFailure(unconfirmed.email, at(1000)), 'unavailable');
    assert.equal((await state(unconfirmed.email)).passwordHash, 'senha-antiga');
    assert.equal((await state(unconfirmed.email)).attempts, 0);
  });
});

test('migration da 021 é aditiva: colunas, CHECKs e índice parcial; preserva as contas existentes', async () => {
  const migrations = new URL('../../../prisma/migrations/', import.meta.url);
  const original = await readFile(
    new URL('20261103140000_global_accounts/migration.sql', migrations),
    'utf8',
  );
  const verification = await readFile(
    new URL('20261103150000_account_verification_attempts/migration.sql', migrations),
    'utf8',
  );
  const sql = await readFile(
    new URL('20261103160000_account_password_reset/migration.sql', migrations),
    'utf8',
  );
  const names = (await readdir(migrations)).filter((name) => /^[0-9]{14}_/.test(name)).sort();
  const previous = names.indexOf('20261103150000_account_verification_attempts');
  const current = names.indexOf('20261103160000_account_password_reset');
  assert.ok(previous >= 0 && current > previous);
  assert.doesNotMatch(sql, /DROP\s+(TABLE|COLUMN|CONSTRAINT)|TRUNCATE|DELETE\s+FROM|UPDATE\s/i);
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
    await client.query(verification);
    const pendingId = randomUUID();
    const confirmedId = randomUUID();
    await client.query(
      `INSERT INTO accounts (id, email, password_hash, verification_hash, verification_expires_at)
       VALUES ($1, 'pendente@example.test', 'hash', 'hmac', '2026-11-03T12:00:00Z')`,
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
      password_hash: string;
      verification_hash: string | null;
      email_verified_at: Date | null;
      reset_hash: string | null;
      reset_expires_at: Date | null;
      reset_attempts: number;
      reset_failures_day: number;
      reset_failures_since: Date | null;
    }>('SELECT * FROM accounts');
    const pending = rows.rows.find((row) => row.id === pendingId);
    const confirmed = rows.rows.find((row) => row.id === confirmedId);
    assert.ok(pending && confirmed);
    // Dados existentes intactos e colunas novas com os valores iniciais.
    assert.equal(pending.verification_hash, 'hmac');
    assert.equal(confirmed.email_verified_at?.toISOString(), '2026-11-01T10:00:00.000Z');
    for (const row of [pending, confirmed]) {
      assert.equal(row.password_hash, 'hash');
      assert.equal(row.reset_hash, null);
      assert.equal(row.reset_expires_at, null);
      assert.equal(row.reset_attempts, 0);
      assert.equal(row.reset_failures_day, 0);
      assert.equal(row.reset_failures_since, null);
    }
    // CHECKs: hash exige vencimento; contadores nunca negativos.
    await client.query('SAVEPOINT antes');
    await assert.rejects(
      client.query("UPDATE accounts SET reset_hash = 'h', reset_expires_at = NULL WHERE id = $1", [
        confirmedId,
      ]),
      /account_reset_expiry/,
    );
    await client.query('ROLLBACK TO SAVEPOINT antes');
    await assert.rejects(
      client.query('UPDATE accounts SET reset_attempts = -1 WHERE id = $1', [confirmedId]),
      /account_reset_counters_check/,
    );
    await client.query('ROLLBACK TO SAVEPOINT antes');
    await client.query(
      "UPDATE accounts SET reset_hash = NULL, reset_expires_at = '2026-11-03T12:00:00Z' WHERE id = $1",
      [confirmedId],
    );
    // Índice parcial do expurgo, só para contas não confirmadas.
    const index = await client.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'accounts_unverified_updated_at_idx'",
      [schema],
    );
    assert.equal(index.rows.length, 1);
    assert.match(index.rows[0]?.indexdef ?? '', /updated_at/);
    assert.match(index.rows[0]?.indexdef ?? '', /email_verified_at IS NULL/);
    await client.query('ROLLBACK');
  } finally {
    await client.end();
  }
});
