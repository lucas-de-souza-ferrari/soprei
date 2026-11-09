import type { FastifyBaseLogger } from 'fastify';
import type { BillingCheckResult, Metrics } from '../../infrastructure/metrics/index.js';
import type { CheckoutRepository } from '../../domain/index.js';
import type { PaymentProvider } from '../ports/payment-provider.js';
import type { PendingReplyResumer } from './pending-reply-resumer.js';

/** Referências do evento ou do retorno do pagamento: só parâmetros da consulta, nunca concedem nada. */
export interface PaymentHints {
  readonly transactionNsu?: string | undefined;
  readonly slug?: string | undefined;
}

export type VerifyResult = BillingCheckResult;

export interface PaymentVerifierDeps {
  readonly checkout: CheckoutRepository;
  readonly provider: PaymentProvider;
  readonly graceDays: number;
  readonly logger: FastifyBaseLogger;
  readonly metrics?: Pick<Metrics, 'countBillingCheck' | 'countBillingOrder'> | undefined;
  readonly resumer?: Pick<PendingReplyResumer, 'resume'> | undefined;
  readonly now?: (() => Date) | undefined;
  /** Espera entre as tentativas da confirmação em segundo plano (injetável nos testes). */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

/** Esperas entre as tentativas do webhook em segundo plano; depois disso a reconciliação cobre. */
const BACKGROUND_BACKOFF_MS = [1_000, 5_000] as const;

/**
 * Confirma um pagamento com o provedor e, só então, concede (spec 031, E3). Nada vem do corpo do webhook
 * nem da query do retorno: a decisão é do payment_check feito pelo servidor com o id do NOSSO pedido,
 * e o valor conferido é o amount (valor do link) contra o amountCents do pedido (o paid_amount pode ser
 * maior por causa das taxas repassadas e não é comparado). Concessão idempotente e atômica no repositório.
 * 401 e 403 do provedor são erro de configuração (alerta), nunca "não pago".
 */
export class PaymentVerifier {
  private readonly background = new Set<Promise<void>>();

  constructor(private readonly deps: PaymentVerifierDeps) {}

  async verify(orderId: string, hints: PaymentHints = {}): Promise<VerifyResult> {
    const result = await this.run(orderId, hints);
    this.deps.metrics?.countBillingCheck(result);
    return result;
  }

  /** Confirma em segundo plano (resposta do webhook já enviada), com poucas tentativas; nunca lança. */
  verifyInBackground(orderId: string, hints: PaymentHints): void {
    const task = this.attempts(orderId, hints).finally(() => {
      this.background.delete(task);
    });
    this.background.add(task);
  }

  /** Espera as confirmações em segundo plano em curso (desligamento do processo). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.background]);
  }

  private async attempts(orderId: string, hints: PaymentHints): Promise<void> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt += 1) {
      let result: VerifyResult;
      try {
        result = await this.verify(orderId, hints);
      } catch (error) {
        this.deps.logger.error(
          { orderId, errName: error instanceof Error ? error.name : typeof error },
          'falha inesperada ao confirmar o pagamento em segundo plano',
        );
        return;
      }
      const backoff = BACKGROUND_BACKOFF_MS[attempt];
      if (result !== 'unavailable' || backoff === undefined) {
        if (result === 'unavailable') {
          this.deps.logger.warn(
            { orderId },
            'confirmação do pagamento indisponível; a reconciliação tentará de novo',
          );
        }
        return;
      }
      await sleep(backoff);
    }
  }

  private async run(orderId: string, hints: PaymentHints): Promise<VerifyResult> {
    const { checkout, provider, logger, metrics } = this.deps;
    const order = await checkout.findOrderById(orderId);
    if (order === null) return 'unknown_order';
    if (order.status === 'PAID') return 'already_paid';
    if (order.status === 'FAILED') return 'ignored';

    const transactionNsu = hints.transactionNsu ?? order.providerTransactionRef ?? undefined;
    const slug = hints.slug ?? order.providerSlug ?? undefined;
    const check = await provider.checkPayment({ orderId: order.id, transactionNsu, slug });
    if (!check.ok) {
      const error = check.error;
      if (error.reason === 'config') {
        // Credencial recusada: alerta de configuração, nunca "não pago".
        logger.error(
          { orderId, httpStatus: error.httpStatus },
          'provedor de pagamento recusou a credencial; confira INFINITEPAY_API_KEY e INFINITEPAY_HANDLE',
        );
        return 'config_error';
      }
      if (error.reason === 'rejected') return 'rejected';
      logger.warn(
        { orderId, reason: error.reason, httpStatus: error.httpStatus },
        'consulta de pagamento indisponível',
      );
      return 'unavailable';
    }
    const outcome = check.value;
    if (!outcome.paid) return 'not_paid';
    if (outcome.amountCents === null) {
      logger.error({ orderId }, 'consulta de pagamento sem o valor do link; nada foi concedido');
      return 'unverifiable';
    }
    if (outcome.amountCents !== order.amountCents) {
      await checkout.markFailed(order.id);
      metrics?.countBillingOrder(order.kind, 'amount_mismatch');
      logger.warn({ orderId }, 'valor pago diverge do pedido; nada foi concedido');
      return 'amount_mismatch';
    }

    const now = this.deps.now?.() ?? new Date();
    const granted = await checkout.grantPaidOrder(
      order.id,
      {
        transactionNsu: transactionNsu ?? null,
        slug: slug ?? null,
        captureMethod: outcome.captureMethod,
      },
      now,
      this.deps.graceDays,
    );
    if (!granted.granted) return 'already_paid';
    metrics?.countBillingOrder(order.kind, 'paid');
    logger.info({ orderId, kind: order.kind }, 'pagamento confirmado e período estendido');
    await this.deps.resumer?.resume(granted.subscriptionId, order.id);
    return 'paid';
  }
}
