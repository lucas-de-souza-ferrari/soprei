import type { FastifyBaseLogger } from 'fastify';
import type { CheckoutRepository } from '../../domain/index.js';
import type { PaymentVerifier } from './payment-verifier.js';

/** Pedidos conferidos por execução (teto; o restante fica para a próxima). */
export const RECONCILE_BATCH_LIMIT = 25;
/** Um pedido conferido há menos que isto não é reconsultado. */
export const RECONCILE_MIN_INTERVAL_MS = 5 * 60_000;
/** Falhas de disponibilidade seguidas que interrompem a execução (não se insiste num provedor fora). */
const MAX_CONSECUTIVE_UNAVAILABLE = 3;

export interface ReconcileSummary {
  readonly checked: number;
  readonly paid: number;
  readonly expired: number;
  readonly stoppedEarly: boolean;
}

/**
 * Reconciliação periódica (spec 031, E3): como o webhook pode não chegar, confere por payment_check os
 * pedidos PENDING recentes (48 h) ainda não conferidos. Reivindica um lote com SKIP LOCKED (duas
 * instâncias nunca pegam o mesmo pedido), confere um a um (sem laço agressivo), expira o que passou do
 * prazo sem pagamento e para sozinha se o provedor recusa a credencial ou está fora. Nunca lança. A
 * mesma instância não se sobrepõe porque roda dentro do timer sem sobreposição.
 */
export class PaymentReconciler {
  constructor(
    private readonly deps: {
      readonly checkout: CheckoutRepository;
      readonly verifier: Pick<PaymentVerifier, 'verify'>;
      readonly logger: FastifyBaseLogger;
      readonly now?: (() => Date) | undefined;
    },
  ) {}

  async runOnce(): Promise<ReconcileSummary> {
    const { checkout, verifier, logger } = this.deps;
    const now = this.deps.now?.() ?? new Date();
    let checked = 0;
    let paid = 0;
    let expired = 0;
    let unavailable = 0;
    let stoppedEarly = false;
    try {
      const ids = await checkout.claimForReconciliation(
        now,
        new Date(now.getTime() - RECONCILE_MIN_INTERVAL_MS),
        RECONCILE_BATCH_LIMIT,
      );
      for (const id of ids) {
        const result = await verifier.verify(id);
        checked += 1;
        if (result === 'config_error') {
          stoppedEarly = true;
          break;
        }
        if (result === 'unavailable') {
          unavailable += 1;
          if (unavailable >= MAX_CONSECUTIVE_UNAVAILABLE) {
            stoppedEarly = true;
            break;
          }
          continue;
        }
        unavailable = 0;
        if (result === 'paid') paid += 1;
        if (result === 'not_paid' || result === 'rejected') {
          if (await checkout.expireIfDue(id, now)) expired += 1;
        }
      }
    } catch (error) {
      logger.error(
        { errName: error instanceof Error ? error.name : typeof error },
        'falha na reconciliação de pagamentos',
      );
      return { checked, paid, expired, stoppedEarly: true };
    }
    if (checked > 0) logger.info({ checked, paid, stoppedEarly }, 'reconciliação de pagamentos');
    return { checked, paid, expired, stoppedEarly };
  }
}
