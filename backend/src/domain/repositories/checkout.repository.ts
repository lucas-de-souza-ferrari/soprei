import type {
  OrderBreakdown,
  PaymentOrderKindValue,
  PaymentOrderStatusValue,
  PendingChange,
} from '../billing.js';

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
  /**
   * Nada foi concedido: o pedido já foi concedido (ou está FAILED, ou não existe), ou a referência da
   * transação já pertence a outro pedido (conflict: a transação foi desfeita; revisão manual).
   */
  /**
   * stale: o pedido ficou obsoleto (upgrade cuja base mudou, ou plano com menos vagas que as empresas atuais);
   * a transação foi desfeita, o pedido virou FAILED e o pagamento vai para revisão manual/estorno.
   */
  | { readonly granted: false; readonly conflict?: boolean; readonly stale?: boolean };

/** Teto de pedidos criados desde um instante, conferido sob a trava da assinatura. */
export interface OrderCap {
  readonly since: Date;
  readonly max: number;
}

/**
 * Pedidos de pagamento (spec 031, E3). Os métodos com accountId só enxergam pedidos **daquela** conta
 * (pedido de outra conta se comporta como inexistente). Os métodos por orderId são **de sistema**
 * (webhook público, reconciliação): só servem a quem já provou conhecer o UUID do pedido e nunca devolvem
 * dado ao chamador externo; a concessão vai sempre à assinatura **do próprio pedido**.
 */
export interface CheckoutRepository {
  /**
   * Grava o pedido PENDING na assinatura da conta. A contagem do teto e a gravação acontecem na mesma
   * transação, com a linha da assinatura travada (criações simultâneas não furam o teto). Devolve null se a
   * conta ainda não tem assinatura e 'limit' se o teto foi atingido.
   */
  createPendingOrder(
    accountId: string,
    input: NewOrderInput,
    cap: OrderCap,
  ): Promise<PaymentOrderRecord | 'limit' | null>;
  findOrder(accountId: string, orderId: string): Promise<PaymentOrderRecord | null>;
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
  /**
   * Marca a consulta ao provedor (last_checked_at) se o pedido ainda pode receber pagamento e não foi
   * consultado há menos de cooldownMs. Verdadeiro = pode consultar agora (cooldown por pedido).
   */
  touchCheck(orderId: string, now: Date, cooldownMs: number): Promise<boolean>;
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
  /**
   * Reivindica até limit pedidos recentes (48 h) ainda sem pagamento, não consultados desde staleBefore
   * (SKIP LOCKED): PENDING e também EXPIRED por substituição que tenham link.
   */
  claimForReconciliation(now: Date, staleBefore: Date, limit: number): Promise<readonly string[]>;
  /** Grava (ou limpa) a troca agendada para a próxima renovação; falso se a conta não tem assinatura. */
  setPendingChange(accountId: string, change: PendingChange | null): Promise<boolean>;
  /** Marca (ou desmarca) o cancelamento no fim do período; falso se a conta não tem assinatura. */
  setCancelAtPeriodEnd(accountId: string, cancel: boolean): Promise<boolean>;
  /** Expira um pedido PENDING cujo prazo passou. */
  expireIfDue(orderId: string, now: Date): Promise<boolean>;
}
