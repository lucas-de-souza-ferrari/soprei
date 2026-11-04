import { INVITATION_EXPIRY_GRACE_MS, type InvitationExpiryRepository } from '../../domain/index.js';
import { PURGE_BATCH_SIZE, PURGE_MAX_BATCHES } from '../auth/unverified-account-purger.js';

export interface InvitationExpiryRunSummary {
  readonly result: 'ok' | 'error';
  /** Convites fechados nesta execução (nunca e-mail nem id). */
  readonly expired: number;
  readonly batches: number;
}

/**
 * Expurgo do e-mail do convidado (spec 025): fecha como `EXPIRED` (e-mail e hash anulados) os
 * convites `PENDING` vencidos há mais de 7 dias, em lotes. A garantia de nunca reverter um convite que
 * o aceite ou a revogação acabou de fechar está no UPDATE (predicado repetido sob lock); aqui só se
 * decide o corte e o tamanho do trabalho. Roda no mesmo ciclo de vida do expurgo de contas.
 */
export class InvitationExpiryPurger {
  constructor(
    private readonly deps: {
      repository: InvitationExpiryRepository;
      now?: () => Date;
      /** Resumo de cada execução; só contagens. Nunca derruba o expurgo. */
      onRun?: (summary: InvitationExpiryRunSummary) => void;
    },
  ) {}

  /** Uma execução: até `PURGE_MAX_BATCHES` lotes. Nunca rejeita: erro do repositório vira `error`. */
  async runOnce(): Promise<InvitationExpiryRunSummary> {
    const now = this.deps.now?.() ?? new Date();
    const cutoff = new Date(now.getTime() - INVITATION_EXPIRY_GRACE_MS);
    let expired = 0;
    let batches = 0;
    let result: 'ok' | 'error' = 'ok';
    try {
      while (batches < PURGE_MAX_BATCHES) {
        const count = await this.deps.repository.expirePending(cutoff, PURGE_BATCH_SIZE);
        batches += 1;
        expired += count;
        if (count < PURGE_BATCH_SIZE) break;
      }
    } catch {
      result = 'error';
    }
    const summary: InvitationExpiryRunSummary = { result, expired, batches };
    try {
      this.deps.onRun?.(summary);
    } catch {
      // Observabilidade nunca derruba o processo.
    }
    return summary;
  }
}
