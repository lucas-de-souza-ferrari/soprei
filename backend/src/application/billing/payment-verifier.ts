import type { FastifyBaseLogger } from 'fastify';
import type { CheckoutRepository } from '../../domain/index.js';
import type { BillingCheckResult, Metrics } from '../../infrastructure/metrics/index.js';
import { messageRef } from '../../shared/utils/index.js';
import type { PaymentCheckOutcome, PaymentProvider } from '../ports/payment-provider.js';
import type { BillingNoticeService } from './billing-notice.service.js';
import type { PendingReplyResumer } from './pending-reply-resumer.js';

/**
 * Referências do evento ou do retorno do pagamento. Vêm de fonte NÃO confiável (corpo do webhook ou
 * navegador): só são usadas como dica na segunda tentativa da consulta, se o provedor exigir, e só são
 * guardadas na linha do pedido depois de uma confirmação paga.
 */
export interface PaymentHints {
  readonly transactionNsu?: string | undefined;
  readonly slug?: string | undefined;
}

export type VerifyResult = BillingCheckResult;

export interface VerifyOptions {
  /** A reconciliação já reivindicou o pedido (marca last_checked_at): não aplica o cooldown de novo. */
  readonly skipCooldown?: boolean;
}

export interface PaymentVerifierDeps {
  readonly checkout: CheckoutRepository;
  readonly provider: PaymentProvider;
  readonly graceDays: number;
  readonly logger: FastifyBaseLogger;
  readonly metrics?: Pick<Metrics, 'countBillingCheck' | 'countBillingOrder'> | undefined;
  readonly resumer?: Pick<PendingReplyResumer, 'resume'> | undefined;
  /** Avisos por e-mail do pagamento concedido (E5); falha nunca derruba a confirmação. */
  readonly notifier?: Pick<BillingNoticeService, 'paymentGranted'> | undefined;
  readonly now?: (() => Date) | undefined;
  /** Espera entre as tentativas da confirmação em segundo plano (injetável nos testes). */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Intervalo mínimo entre consultas ao provedor do mesmo pedido (0 desliga). Padrão 10 s. */
  readonly cooldownMs?: number | undefined;
  /** Teto de confirmações simultâneas em segundo plano. Padrão 20. */
  readonly maxBackground?: number | undefined;
}

/** Esperas entre as tentativas do webhook em segundo plano; depois disso a reconciliação cobre. */
const BACKGROUND_BACKOFF_MS = [1_000, 5_000] as const;
/** Teto da espera pedida pelo provedor (Retry-After) no backoff. */
const MAX_BACKOFF_MS = 30_000;
const DEFAULT_COOLDOWN_MS = 10_000;
const DEFAULT_MAX_BACKGROUND = 20;

interface Detailed {
  readonly result: VerifyResult;
  readonly retryAfterMs?: number;
}

export type BackgroundStart = 'started' | 'duplicate' | 'capacity';

/**
 * Confirma um pagamento com o provedor e, só então, concede (spec 031, E3). Nada vem do corpo do webhook
 * nem da query do retorno: a decisão é do payment_check feito pelo servidor com o id do NOSSO pedido,
 * e o valor conferido é o amount (valor do link) contra o amountCents do pedido (o paid_amount pode ser
 * maior por causa das taxas repassadas e não é comparado). A consulta usa primeiro só handle e
 * order_nsu; transaction_nsu e slug só entram numa segunda tentativa, se o provedor recusar a primeira
 * com um 4xx específico. Valor divergente NÃO é terminal (a unidade do amount é suposição): o pedido
 * segue PENDING, com erro e métrica. 401 e 403 são erro de configuração, nunca "não pago".
 */
export class PaymentVerifier {
  private readonly background = new Set<Promise<void>>();
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: PaymentVerifierDeps) {}

  async verify(
    orderId: string,
    hints: PaymentHints = {},
    options: VerifyOptions = {},
  ): Promise<VerifyResult> {
    return (await this.verifyDetailed(orderId, hints, options)).result;
  }

  /** Confirma em segundo plano (resposta do webhook já enviada); duplicata e excesso são descartados. */
  verifyInBackground(orderId: string, hints: PaymentHints): BackgroundStart {
    if (this.inFlight.has(orderId)) return 'duplicate';
    if (this.inFlight.size >= (this.deps.maxBackground ?? DEFAULT_MAX_BACKGROUND)) {
      this.deps.logger.warn(
        { orderRef: messageRef(orderId) },
        'confirmações em segundo plano no limite; a reconciliação cobre',
      );
      return 'capacity';
    }
    this.inFlight.add(orderId);
    this.track(
      this.attempts(orderId, hints).finally(() => {
        this.inFlight.delete(orderId);
      }),
    );
    return 'started';
  }

  /** Espera as confirmações em segundo plano em curso (desligamento do processo). */
  async drain(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  private track(task: Promise<void>): void {
    this.background.add(task);
    void task.finally(() => {
      this.background.delete(task);
    });
  }

  private async verifyDetailed(
    orderId: string,
    hints: PaymentHints,
    options: VerifyOptions,
  ): Promise<Detailed> {
    const detailed = await this.run(orderId, hints, options);
    this.deps.metrics?.countBillingCheck(detailed.result);
    return detailed;
  }

  private async attempts(orderId: string, hints: PaymentHints): Promise<void> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt += 1) {
      let detailed: Detailed;
      try {
        detailed = await this.verifyDetailed(orderId, hints, { skipCooldown: true });
      } catch (error) {
        this.deps.logger.error(
          {
            orderRef: messageRef(orderId),
            errName: error instanceof Error ? error.name : typeof error,
          },
          'falha inesperada ao confirmar o pagamento em segundo plano',
        );
        return;
      }
      const backoff = BACKGROUND_BACKOFF_MS[attempt];
      if (detailed.result !== 'unavailable' || backoff === undefined) {
        if (detailed.result === 'unavailable') {
          this.deps.logger.warn(
            { orderRef: messageRef(orderId) },
            'confirmação do pagamento indisponível; a reconciliação tentará de novo',
          );
        }
        return;
      }
      await sleep(Math.min(Math.max(backoff, detailed.retryAfterMs ?? 0), MAX_BACKOFF_MS));
    }
  }

  private async run(
    orderId: string,
    hints: PaymentHints,
    options: VerifyOptions,
  ): Promise<Detailed> {
    const { checkout, provider, logger, metrics } = this.deps;
    const orderRef = messageRef(orderId);
    const order = await checkout.findOrderById(orderId);
    if (order === null) return { result: 'unknown_order' };
    if (order.status === 'PAID') return { result: 'already_paid' };
    if (order.status === 'FAILED') return { result: 'ignored' };

    const now = this.deps.now?.() ?? new Date();
    const cooldownMs = this.deps.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    if (cooldownMs > 0 && options.skipCooldown !== true) {
      if (!(await checkout.touchCheck(order.id, now, cooldownMs))) return { result: 'cooldown' };
    }

    // 1ª tentativa: só handle e order_nsu. As referências vindas de fonte não confiável só entram se o
    // provedor recusar a primeira com um 4xx específico (estratégia tolerante).
    let check = await provider.checkPayment({ orderId: order.id });
    const refs: PaymentHints = {
      transactionNsu: hints.transactionNsu ?? order.providerTransactionRef ?? undefined,
      slug: hints.slug ?? order.providerSlug ?? undefined,
    };
    if (
      !check.ok &&
      check.error.reason === 'rejected' &&
      (refs.transactionNsu !== undefined || refs.slug !== undefined)
    ) {
      check = await provider.checkPayment({ orderId: order.id, ...refs });
    }
    if (!check.ok) {
      const error = check.error;
      if (error.reason === 'config') {
        logger.error(
          { orderRef, httpStatus: error.httpStatus },
          'provedor de pagamento recusou a credencial; confira INFINITEPAY_API_KEY e INFINITEPAY_HANDLE',
        );
        return { result: 'config_error' };
      }
      if (error.reason === 'rejected') return { result: 'rejected' };
      logger.warn(
        { orderRef, reason: error.reason, httpStatus: error.httpStatus },
        'consulta de pagamento indisponível',
      );
      return {
        result: 'unavailable',
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      };
    }
    const outcome: PaymentCheckOutcome = check.value;
    if (!outcome.paid) return { result: 'not_paid' };
    if (outcome.amountCents === null) {
      logger.error({ orderRef }, 'consulta de pagamento sem o valor do link; nada foi concedido');
      return { result: 'unverifiable' };
    }
    if (outcome.amountCents !== order.amountCents) {
      // Não terminal: a unidade do amount é suposição; uma confirmação posterior correta ainda concede.
      metrics?.countBillingOrder(order.kind, 'amount_mismatch');
      logger.error(
        { orderRef },
        'valor confirmado diverge do pedido; nada foi concedido (revisão manual)',
      );
      return { result: 'amount_mismatch' };
    }

    const granted = await checkout.grantPaidOrder(
      order.id,
      {
        // Só a referência que o PROVEDOR devolveu (nunca a dica do corpo do webhook ou do navegador).
        transactionNsu: outcome.transactionNsu,
        slug: outcome.slug,
        captureMethod: outcome.captureMethod,
      },
      now,
      this.deps.graceDays,
    );
    if (!granted.granted) {
      if (granted.stale !== undefined) {
        // Pedido obsoleto (upgrade com a base mudada, renovação de plano que já não vale ou plano que não
        // comporta as empresas): nada concedido; o pedido virou FAILED e o pagamento vai para revisão manual.
        const upgrade = granted.stale === 'upgrade';
        metrics?.countBillingOrder(order.kind, upgrade ? 'upgrade_stale' : 'renewal_stale');
        logger.error(
          { orderRef },
          'pedido obsoleto no pagamento; nada concedido (revisão manual ou estorno)',
        );
        return { result: upgrade ? 'upgrade_stale' : 'renewal_stale' };
      }
      if (granted.conflict === true) {
        // A referência já pertence a outro pedido: nada foi concedido e a transação foi desfeita.
        metrics?.countBillingOrder(order.kind, 'reference_conflict');
        logger.error(
          { orderRef },
          'referência de pagamento já usada em outro pedido; revisão manual',
        );
        return { result: 'reference_conflict' };
      }
      return { result: 'already_paid' };
    }
    metrics?.countBillingOrder(order.kind, 'paid');
    logger.info({ orderRef, kind: order.kind }, 'pagamento confirmado e período estendido');
    const resumer = this.deps.resumer;
    if (resumer !== undefined) {
      // Em segundo plano: o "Já paguei" e o webhook não esperam o reagendamento das mensagens.
      this.track(resumer.resume(granted.subscriptionId, order.id).then(() => undefined));
    }
    const notifier = this.deps.notifier;
    if (notifier !== undefined) {
      // Em segundo plano e depois do commit: o recibo por e-mail não atrasa nem derruba a confirmação (o
      // serviço nunca rejeita) e o drain() do desligamento o espera.
      this.track(
        notifier.paymentGranted({
          subscriptionId: granted.subscriptionId,
          paidAt: now,
          orderKind: order.kind,
          appliedPendingChange: granted.appliedPendingChange === true,
        }),
      );
    }
    return { result: 'paid' };
  }
}
