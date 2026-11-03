import type { UnverifiedAccountPurgeRepository } from '../../../domain/index.js';
import type { TenantScopedPrisma } from '../extensions/tenant-scope.js';
import { withRepositoryErrors } from './repository-errors.js';

/**
 * Expurgo de contas nunca confirmadas (spec 021). SQL cru controlado: `accounts` é global e a única
 * leitura de `users` é a existência de `account_id` (nenhuma coluna de tenant é lida nem devolvida).
 */
export class PrismaUnverifiedAccountPurgeRepository implements UnverifiedAccountPurgeRepository {
  constructor(private readonly db: TenantScopedPrisma) {}

  purgeUnverified(cutoff: Date, batchSize: number): Promise<number> {
    return withRepositoryErrors('Account.purgeUnverified', async () => {
      // O SELECT trava as linhas candidatas (SKIP LOCKED: outra instância ou uma confirmação em
      // curso não bloqueia a varredura) e o DELETE repete o predicado: se a confirmação gravou
      // primeiro, a linha atualizada não casa mais e não é apagada. Só ids voltam; contamos linhas.
      // O CTE é MATERIALIZED de propósito: como subconsulta de IN o planejador pode reexecutar o
      // LIMIT ... FOR UPDATE por linha e apagar mais do que o lote (visto em teste).
      const rows = await this.db.$queryRaw<{ id: string }[]>`
        WITH picked AS MATERIALIZED (
          SELECT a.id FROM accounts a
          WHERE a.email_verified_at IS NULL
            AND a.updated_at < ${cutoff}::timestamptz
            AND NOT EXISTS (SELECT 1 FROM users u WHERE u.account_id = a.id)
          ORDER BY a.updated_at
          LIMIT ${batchSize}::int
          FOR UPDATE SKIP LOCKED)
        DELETE FROM accounts
        WHERE id IN (SELECT id FROM picked)
          AND email_verified_at IS NULL
          AND updated_at < ${cutoff}::timestamptz
          AND NOT EXISTS (SELECT 1 FROM users u WHERE u.account_id = accounts.id)
        RETURNING id`;
      return rows.length;
    });
  }
}
