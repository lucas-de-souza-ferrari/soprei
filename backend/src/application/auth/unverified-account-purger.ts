import type { UnverifiedAccountPurgeRepository } from '../../domain/index.js';

/** Tamanho de cada lote e teto de lotes por execução (spec 021); constantes, não configuração. */
export const PURGE_BATCH_SIZE = 100;
export const PURGE_MAX_BATCHES = 10;
const DAY_MS = 24 * 60 * 60_000;

export interface PurgeRunSummary {
  readonly result: 'ok' | 'error';
  /** Contas apagadas nesta execução (nunca e-mail nem id). */
  readonly purged: number;
  readonly batches: number;
}

/**
 * Expurgo de contas nunca confirmadas (spec 021): apaga, em lotes, as que continuam sem
 * confirmação, sem nenhum vínculo e sem atividade (`updated_at`) há mais que a retenção. A garantia
 * de nunca apagar conta confirmada está no DELETE (predicado repetido sob lock); aqui só se decide
 * o corte e o tamanho do trabalho.
 */
export class UnverifiedAccountPurger {
  constructor(
    private readonly deps: {
      repository: UnverifiedAccountPurgeRepository;
      retentionDays: number;
      now?: () => Date;
      /** Resumo de cada execução; só contagens. Nunca derruba o expurgo. */
      onRun?: (summary: PurgeRunSummary) => void;
    },
  ) {}

  /** Uma execução: até `PURGE_MAX_BATCHES` lotes. Nunca rejeita: erro do repositório vira `error`. */
  async runOnce(): Promise<PurgeRunSummary> {
    const now = this.deps.now?.() ?? new Date();
    const cutoff = new Date(now.getTime() - this.deps.retentionDays * DAY_MS);
    let purged = 0;
    let batches = 0;
    let result: 'ok' | 'error' = 'ok';
    try {
      while (batches < PURGE_MAX_BATCHES) {
        const count = await this.deps.repository.purgeUnverified(cutoff, PURGE_BATCH_SIZE);
        batches += 1;
        purged += count;
        if (count < PURGE_BATCH_SIZE) break;
      }
    } catch {
      result = 'error';
    }
    const summary: PurgeRunSummary = { result, purged, batches };
    try {
      this.deps.onRun?.(summary);
    } catch {
      // Observabilidade nunca derruba o processo.
    }
    return summary;
  }
}
