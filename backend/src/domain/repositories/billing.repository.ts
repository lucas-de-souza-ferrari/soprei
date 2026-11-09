import type {
  BillingCycle,
  PaymentOrderKindValue,
  PaymentOrderStatusValue,
  PlanPriceRecord,
  PlanRecord,
  SubscriptionRecord,
  UsageNumbers,
} from '../billing.js';

/** Quanto dura o teste gratuito (spec 031, D7): vem da config; o catálogo vem do banco. */
export interface TrialSettings {
  readonly trialDays: number;
}

/**
 * Política de cobrança que o `createCompany` aplica DENTRO da transação que já trava a conta (spec 031):
 * garante a assinatura (teste gratuito na primeira vez), confere acesso e limite de empresas e grava
 * `Company.subscriptionId`. Ausente = cobrança desligada: nada muda.
 */
export interface CompanyBillingPolicy extends TrialSettings {
  readonly now: Date;
  readonly graceDays: number;
}

export interface CatalogEntry {
  readonly plan: PlanRecord;
  /** Preço vigente em `now` por ciclo (a versão mais nova com `validFrom <= now`). */
  readonly prices: readonly PlanPriceRecord[];
}

export interface UsageWindow extends UsageNumbers {
  readonly windowStart: Date;
}

export interface OrderSummary {
  readonly id: string;
  readonly kind: PaymentOrderKindValue;
  readonly status: PaymentOrderStatusValue;
  readonly amountCents: number;
  readonly createdAt: Date;
  readonly paidAt: Date | null;
}

/**
 * Cobrança da CONTA (spec 031). Todo método recebe o `AccountId` como primeiro parâmetro e só enxerga a
 * assinatura, os pedidos e o uso **daquela** conta (o que é de outra conta se comporta como inexistente).
 * Os models são globais: a barreira é este repositório, não a `tenant-scope`.
 */
export interface BillingRepository {
  findSubscription(accountId: string): Promise<SubscriptionRecord | null>;
  /** A assinatura da conta; se não existe, cria o teste gratuito (uma vez por conta, atômico). */
  ensureTrial(accountId: string, now: Date, settings: TrialSettings): Promise<SubscriptionRecord>;
  /** Catálogo para exibição; o modo "Soprei paga a Meta" só entra com `allowSopreiPaysMeta`. */
  catalog(now: Date, allowSopreiPaysMeta: boolean): Promise<readonly CatalogEntry[]>;
  /** Uso da janela que começa em `windowStart` (zeros se ainda não há contador). */
  usage(accountId: string, windowStart: Date): Promise<UsageWindow>;
  listOrders(accountId: string, limit: number): Promise<readonly OrderSummary[]>;
  findOrder(accountId: string, orderId: string): Promise<OrderSummary | null>;
  /** Quantas empresas (não removidas) a assinatura da conta tem. */
  countCompanies(accountId: string): Promise<number>;
  /**
   * Como countCompanies, mais as empresas em que a conta é OWNER ativa e que ainda não têm assinatura (ainda
   * não adotadas): é a conta que vale para recusar uma troca para plano com menos vagas.
   */
  countCompaniesIncludingUnadopted(accountId: string): Promise<number>;
}

export type { BillingCycle };
