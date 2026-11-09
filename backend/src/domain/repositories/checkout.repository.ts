import type { OrderBreakdown, PaymentOrderKindValue, PaymentOrderStatusValue } from '../billing.js';

/** Pedido de pagamento como o checkout o enxerga. Nunca carrega cartão, pagador nem corpo de webhook. */
export interface PaymentOrderRecord {
  readonly id: string;
  readonly subscriptionId: string;
  readonly kind: PaymentOrderKindValue;
  readonly status: PaymentOrderStatusValue;
  readonly amountCents: number;
  readonly breakdown: OrderBreakdown;
  readonly checkoutUrl: string | null;
  readonly providerTransactionRef: string | null;
  readonly providerSlug: string | null;
  readonly paidAt: Date | null;
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export interface NewOrderInput {
  /** UUID gerado pelo servidor: é também o order_nsu mandado à InfinitePay. */
  readonly id: string;
  readonly kind: PaymentOrderKindValue;
  readonly amountCents: number;
  readonly breakdown: OrderBreakdown;
  readonly expiresAt: Date;
}

/** Fatos do pagamento confirmado pela consulta ao provedor (só ids curtos e a forma de pagamento). */
export interface PaidFacts {
  readonly transactionNsu: string | null;
  readonly slug: string | null;
  readonly captureMethod: string | null;
}

export type GrantResult =
  | {
      readonly granted: true;
      readonly subscriptionId: string;
      readonly periodStart: Date;
      readonly periodEnd: Date;
    }
  /** O pedido já foi concedido (ou está FAILED, ou não existe): nada mudou. */
  | { readonly granted: false };

/**
 * Pedidos de pagamento (spec 031, E3). Os métodos com accountId só enxergam pedidos **daquela** conta
 * (pedido de outra conta se comporta como inexistente). Os métodos por orderId são **de sistema**
 * (webhook público, reconciliação): só servem a quem já provou conhecer o UUID do pedido e nunca devolvem
 * dado ao chamador externo; a concessão vai sempre à assinatura **do próprio pedido**.
 */
export interface CheckoutRepository {
  /** Grava o pedido PENDING na assinatura da conta; null se a conta ainda não tem assinatura. */
  createPendingOrder(accountId: string, input: NewOrderInput): Promise<PaymentOrderRecord | null>;
  findOrder(accountId: string, orderId: string): Promise<PaymentOrderRecord | null>;
  countOrdersSince(accountId: string, since: Date): Promise<number>;
  /** Guarda o link criado (só em pedido PENDING ainda sem link). */
  attachCheckoutUrl(orderId: string, checkoutUrl: string): Promise<void>;
  /** Apaga um pedido PENDING que nunca ganhou link (falha ao criar o link: nada pendurado). */
  discardUnlinkedOrder(orderId: string): Promise<void>;
  /** Expira os outros pedidos PENDING da mesma assinatura e tipo (o novo substitui os anteriores). */
  expireSiblings(
    subscriptionId: string,
    kind: PaymentOrderKindValue,
    exceptId: string,
  ): Promise<void>;

  findOrderById(orderId: string): Promise<PaymentOrderRecord | null>;
  /** Guarda a última referência de transação e a fatura informadas pelo webhook (ainda NÃO confirmadas). */
  recordWebhookEvent(
    orderId: string,
    event: { readonly transactionNsu: string; readonly slug: string | null },
  ): Promise<boolean>;
  /**
   * Concede o pagamento: PENDING ou EXPIRED vira PAID por updateMany condicional (quem atualiza 0 linhas não
   * concede de novo) e, **na mesma transação**, estende o período da assinatura do pedido, aplica o plano e
   * os módulos do breakdown e cria a janela de uso. Idempotente e atômica.
   */
  grantPaidOrder(
    orderId: string,
    facts: PaidFacts,
    now: Date,
    graceDays: number,
  ): Promise<GrantResult>;
  /** Marca o pedido como FAILED (valor divergente), só se ainda não foi pago. */
  markFailed(orderId: string): Promise<void>;
  /** Reivindica até limit pedidos PENDING recentes não consultados desde staleBefore (SKIP LOCKED). */
  claimForReconciliation(now: Date, staleBefore: Date, limit: number): Promise<readonly string[]>;
  /** Expira um pedido PENDING cujo prazo passou. */
  expireIfDue(orderId: string, now: Date): Promise<boolean>;
}
