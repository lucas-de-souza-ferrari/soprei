import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  runAccountRepositoryContract,
  type VerificationState,
} from '../../test-support/account-repository-contract.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { createDatabase, PrismaAccountRepository } from './index.js';

const config = loadIntegrationConfig();
const T0 = new Date('2026-11-03T12:00:00.000Z');
const TTL = 15 * 60_000;

async function withRepository(
  body: (ctx: {
    repo: PrismaAccountRepository;
    newEmail: () => string;
    state: (email: string) => Promise<VerificationState>;
    seed: (hash: string) => Promise<{ id: string; email: string }>;
  }) => Promise<void>,
): Promise<void> {
  const logs = captureLogs();
  const db = createDatabase(config, logs.logger);
  const repo = new PrismaAccountRepository(db.prisma);
  const emails: string[] = [];
  const newEmail = (): string => {
    const email = `verif-${randomUUID()}@example.test`;
    emails.push(email);
    return email;
  };
  const state = async (email: string): Promise<VerificationState> => {
    const row = await db.prisma.account.findUnique({ where: { email } });
    assert.ok(row);
    return {
      hash: row.verificationHash,
      expiresAt: row.verificationExpiresAt,
      attempts: row.verificationAttempts,
      failuresDay: row.verificationFailuresDay,
      failuresSince: row.verificationFailuresSince,
      emailVerifiedAt: row.emailVerifiedAt,
    };
  };
  const seed = async (hash: string): Promise<{ id: string; email: string }> => {
    const email = newEmail();
    const id = await repo.registerUnverified({
      id: randomUUID(),
      email,
      passwordHash: 'senha-hash',
      verificationHash: hash,
      expiresAt: new Date(T0.getTime() + TTL),
      retryBefore: new Date(T0.getTime() + TTL - 60_000),
      now: T0,
    });
    assert.ok(id);
    return { id, email };
  };
  try {
    await body({ repo, newEmail, state, seed });
  } finally {
    await db.prisma.account.deleteMany({ where: { email: { in: emails } } });
    await db.close();
  }
}

test('contrato do repositório de contas no Postgres real (spec 020)', async () => {
  await withRepository(async ({ repo, newEmail, state }) => {
    await runAccountRepositoryContract({ repo, state }, newEmail);
  });
});

test('50 erros simultâneos no mesmo código dão exatamente 5 incrementos e o código morre', async () => {
  await withRepository(async ({ repo, state, seed }) => {
    const { id, email } = await seed('hash-correto');
    const at = new Date(T0.getTime() + 1000);
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => repo.verify(id, `errado-${i}`, at)),
    );
    const count = (outcome: string): number => results.filter((r) => r === outcome).length;
    assert.equal(count('wrong'), 4);
    assert.equal(count('exhausted'), 1);
    assert.equal(count('unavailable'), 45);
    const row = await state(email);
    assert.equal(row.attempts, 5);
    assert.equal(row.hash, null);
    assert.equal(row.failuresDay, 5);
    assert.equal(row.emailVerifiedAt, null);
    // Nenhuma tentativa posterior casa, nem a certa.
    assert.equal(
      await repo.verify(id, 'hash-correto', new Date(T0.getTime() + 2000)),
      'unavailable',
    );
    assert.equal((await state(email)).emailVerifiedAt, null);
    assert.equal((await state(email)).attempts, 5);
  });
});

test('20 erros simultâneos e 1 certa: a certa só confirma antes do 5º erro; nunca passa de 5', async () => {
  await withRepository(async ({ repo, state, seed }) => {
    // Várias rodadas no mesmo teste, com a tentativa certa em posições diferentes da fila.
    for (let round = 0; round < 7; round += 1) {
      const { id, email } = await seed('hash-correto');
      const at = new Date(T0.getTime() + 1000);
      const position = round * 3;
      const results = await Promise.all(
        Array.from({ length: 21 }, (_, i) =>
          repo.verify(id, i === position ? 'hash-correto' : `errado-${i}`, at),
        ),
      );
      const count = (outcome: string): number => results.filter((r) => r === outcome).length;
      const row = await state(email);
      assert.ok(row.attempts <= 5, `rodada ${round}: attempts ${row.attempts}`);
      assert.ok(count('verified') <= 1);
      assert.ok(count('wrong') + count('exhausted') <= 5);
      if (count('verified') === 1) {
        assert.ok(row.emailVerifiedAt, `rodada ${round}`);
        assert.equal(row.hash, null);
        assert.equal(row.attempts, 0);
        assert.equal(count('exhausted'), 0);
        assert.ok(count('wrong') <= 4);
      } else {
        assert.equal(row.emailVerifiedAt, null, `rodada ${round}`);
        assert.equal(row.attempts, 5);
        assert.equal(row.hash, null);
        assert.equal(count('exhausted'), 1);
      }
    }
  });
});

test('o código certo depois do 5º erro não confirma a conta', async () => {
  await withRepository(async ({ repo, state, seed }) => {
    const { id, email } = await seed('hash-correto');
    for (let i = 0; i < 4; i += 1) {
      assert.equal(await repo.verify(id, 'errado', new Date(T0.getTime() + 1000 + i)), 'wrong');
    }
    assert.equal(await repo.verify(id, 'errado', new Date(T0.getTime() + 1100)), 'exhausted');
    assert.equal(
      await repo.verify(id, 'hash-correto', new Date(T0.getTime() + 1200)),
      'unavailable',
    );
    const row = await state(email);
    assert.equal(row.emailVerifiedAt, null);
    assert.equal(row.hash, null);
    // O vencimento fica, então o intervalo de 60 s do reenvio continua valendo.
    assert.equal(row.expiresAt?.getTime(), T0.getTime() + TTL);
  });
});

test('o teto diário vale sob concorrência: 40 erros simultâneos em códigos reenviados nunca passam de 25 no dia', async () => {
  await withRepository(async ({ repo, state, seed }) => {
    const { id, email } = await seed('hash-0');
    const at = new Date(T0.getTime() + 1000);
    // Cinco códigos (cada um aceita 5 erros), cada rodada com 8 erros simultâneos.
    for (let cycle = 0; cycle < 5; cycle += 1) {
      if (cycle > 0) {
        const start = cycle * 61_000;
        const refreshed = await repo.refreshVerification(
          id,
          `hash-${cycle}`,
          new Date(T0.getTime() + start + TTL),
          new Date(T0.getTime() + start + TTL - 60_000),
          new Date(T0.getTime() + start),
        );
        assert.equal(refreshed, true);
      }
      const when = new Date(at.getTime() + cycle * 61_000);
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => repo.verify(id, `errado-${i}`, when)),
      );
      assert.equal(results.filter((r) => r === 'wrong').length, 4);
      assert.equal(results.filter((r) => r === 'exhausted').length, 1);
    }
    const row = await state(email);
    assert.equal(row.failuresDay, 25);
    assert.equal(row.hash, null);
    // 25 erros na janela: nenhum código novo.
    const blocked = await repo.refreshVerification(
      id,
      'hash-novo',
      new Date(T0.getTime() + 400_000 + TTL),
      new Date(T0.getTime() + 400_000 + TTL - 60_000),
      new Date(T0.getTime() + 400_000),
    );
    assert.equal(blocked, false);
  });
});
