import type { InvitationExpiryRepository } from '../../../domain/index.js';
import type { TenantScopedPrisma } from '../extensions/tenant-scope.js';
import { withRepositoryErrors } from './repository-errors.js';

/**
 * Expurgo do e-mail dos convites pendentes vencidos há muito tempo (spec 025). SQL cru controlado, o
 * **único** que atravessa empresas na tabela de convites: só faz `UPDATE ... SET status = 'EXPIRED',
 * email = NULL, token_hash = NULL` sob um predicado repetido, sem ler nem devolver dado de empresa
 * (voltam só ids, que se contam).
 */
export class PrismaInvitationExpiryRepository implements InvitationExpiryRepository {
  constructor(private readonly db: TenantScopedPrisma) {}

  expirePending(cutoff: Date, batchSize: number): Promise<number> {
    return withRepositoryErrors('CompanyInvitation.expirePending', async () => {
      // O SELECT trava os candidatos (SKIP LOCKED: aceite, revogação ou reenvio em curso não
      // bloqueiam a varredura) e o UPDATE repete o predicado: se o aceite fechou primeiro, a linha já
      // não é PENDING e nunca é revertida. CTE MATERIALIZED de propósito (ver o expurgo de contas).
      const rows = await this.db.$queryRaw<{ id: string }[]>`
        WITH picked AS MATERIALIZED (
          SELECT id FROM company_invitations
          WHERE status = 'PENDING' AND expires_at < ${cutoff}::timestamptz
          ORDER BY expires_at
          LIMIT ${batchSize}::int
          FOR UPDATE SKIP LOCKED)
        UPDATE company_invitations
        SET status = 'EXPIRED', email = NULL, token_hash = NULL, closed_at = CURRENT_TIMESTAMP
        WHERE id IN (SELECT id FROM picked)
          AND status = 'PENDING'
          AND expires_at < ${cutoff}::timestamptz
        RETURNING id`;
      return rows.length;
    });
  }
}
