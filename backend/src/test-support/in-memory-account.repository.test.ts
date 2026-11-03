import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  runAccountRepositoryContract,
  runPasswordResetContract,
} from './account-repository-contract.js';
import { InMemoryAccountRepository } from './in-memory-account.repository.js';

test('repositório de contas em memória cumpre o mesmo contrato do Postgres (spec 020)', async () => {
  const repo = new InMemoryAccountRepository();
  await runAccountRepositoryContract(
    {
      repo,
      state: (email) => {
        const row = repo.peek(email);
        return Promise.resolve({
          hash: row.verificationHash,
          expiresAt: row.verificationExpiresAt,
          attempts: row.verificationAttempts,
          failuresDay: row.verificationFailuresDay,
          failuresSince: row.verificationFailuresSince,
          emailVerifiedAt: row.emailVerifiedAt,
        });
      },
    },
    () => `memoria-${randomUUID()}@example.test`,
  );
});

test('repositório de contas em memória cumpre o contrato da recuperação de senha (spec 021)', async () => {
  const repo = new InMemoryAccountRepository();
  await runPasswordResetContract(
    {
      repo,
      resetState: (email) => {
        const row = repo.peek(email);
        return Promise.resolve({
          hash: row.resetHash,
          expiresAt: row.resetExpiresAt,
          attempts: row.resetAttempts,
          failuresDay: row.resetFailuresDay,
          failuresSince: row.resetFailuresSince,
          passwordHash: row.passwordHash,
        });
      },
    },
    () => `memoria-${randomUUID()}@example.test`,
  );
});
