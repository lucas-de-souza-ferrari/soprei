/**
 * Planos e assinaturas (spec 031): tipos, constantes e regras PURAS (sem banco, sem relógio global).
 * Dinheiro sempre em centavos inteiros (BRL). Nada aqui guarda texto de mensagem, contato nem e-mail.
 */

export const PLAN_CODES = ['ESSENTIAL', 'PROFESSIONAL', 'SCALE'] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

export const BILLING_CYCLES = ['MONTHLY', 'ANNUAL'] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

export const SUBSCRIPTION_STATUSES = [
  'TRIAL',
  'ACTIVE',
  'PAST_DUE',
  'CANCELLED',
  'EXPIRED',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Quem paga a Meta (spec 031, D0). O modo S só existe com `SOPREI_PAYS_META_ENABLED` (gate). */
export const WHATSAPP_BILLING_MODES = ['CUSTOMER_PAYS_META', 'SOPREI_PAYS_META'] as const;
export type WhatsappBillingMode = (typeof WHATSAPP_BILLING_MODES)[number];

/** Módulos opcionais contratados à parte (D9). Conhecimento é do plano base. */
export const CONTRACT_MODULES = ['schedule', 'inventory'] as const;
export type ContractModule = (typeof CONTRACT_MODULES)[number];

/** Tokens somados à cota de tokens por resposta extra comprada (spec 031, pacote extra). */
export const TOKENS_PER_EXTRA_REPLY = 8_000;
export const PAYMENT_ORDER_KINDS = ['NEW', 'RENEWAL', 'UPGRADE', 'EXTRA_PACK'] as const;
export type PaymentOrderKindValue = (typeof PAYMENT_ORDER_KINDS)[number];
export const PAYMENT_ORDER_STATUSES = ['PENDING', 'PAID', 'EXPIRED', 'FAILED'] as const;
export type PaymentOrderStatusValue = (typeof PAYMENT_ORDER_STATUSES)[number];

/** Teto absoluto de empresas por conta (defesa que continua valendo com a cobrança). */
export const ACCOUNT_COMPANY_HARD_CAP = 20;
/** Fração a partir da qual o dono é avisado (80% e 100% de cada cota). */
export const QUOTA_ALERT_FRACTIONS = [0.8, 1] as const;

export interface PlanRecord {
  readonly id: string;
  readonly code: PlanCode;
  readonly name: string;
  readonly maxCompanies: number;
  readonly monthlyTokens: number;
  readonly monthlyReplies: number;
  /** Estimativa do custo da Meta por mensagem enviada, em milésimos de centavo (só exibição, S9). */
  readonly metaEstimateMilliCents: number;
  readonly version: number;
}

export interface PlanPriceRecord {
  readonly id: string;
  readonly cycle: BillingCycle;
  readonly baseCents: number;
  readonly agendaCents: number;
  readonly stockCents: number;
  readonly whatsappBillingMode: WhatsappBillingMode;
  readonly metaPerReplyMilliCents: number;
  readonly extraPackCents: number;
  readonly extraPackReplies: number;
  readonly version: number;
  readonly validFrom: Date;
}

export interface SubscriptionRecord {
  readonly id: string;
  readonly accountId: string;
  readonly plan: PlanRecord;
  readonly price: PlanPriceRecord;
  readonly cycle: BillingCycle;
  readonly agendaEnabled: boolean;
  readonly stockEnabled: boolean;
  readonly status: SubscriptionStatus;
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
  readonly trialEndsAt: Date | null;
  readonly cancelAtPeriodEnd: boolean;
}

export type AccessLevel = 'ok' | 'grace' | 'blocked';

export interface ResolvedAccess {
  /** Estado efetivo, derivado do tempo (nada depende de um timer ter rodado). */
  readonly state: SubscriptionStatus;
  readonly access: AccessLevel;
}

const DAY_MS = 86_400_000;

/**
 * Estado efetivo e nível de acesso de uma assinatura em `now` (relógio injetado). Limites exatos: no
 * instante do vencimento o período já acabou (carência); no instante do fim da carência já bloqueia.
 * - TRIAL: ok até `trialEndsAt`, depois bloqueado (EXPIRED).
 * - ACTIVE/PAST_DUE: ok até `currentPeriodEnd`; depois, carência de `graceDays`; depois, bloqueado.
 * - CANCELLED (ou `cancelAtPeriodEnd`): ok até `currentPeriodEnd`, sem carência.
 * - EXPIRED: bloqueado.
 */
export function resolveAccess(
  subscription: Pick<
    SubscriptionRecord,
    'status' | 'currentPeriodEnd' | 'trialEndsAt' | 'cancelAtPeriodEnd'
  >,
  now: Date,
  graceDays: number,
): ResolvedAccess {
  const t = now.getTime();
  const periodEnd = subscription.currentPeriodEnd.getTime();
  switch (subscription.status) {
    case 'TRIAL': {
      const end = (subscription.trialEndsAt ?? subscription.currentPeriodEnd).getTime();
      return t < end ? { state: 'TRIAL', access: 'ok' } : { state: 'EXPIRED', access: 'blocked' };
    }
    case 'EXPIRED':
      return { state: 'EXPIRED', access: 'blocked' };
    case 'CANCELLED':
      return t < periodEnd
        ? { state: 'CANCELLED', access: 'ok' }
        : { state: 'EXPIRED', access: 'blocked' };
    case 'ACTIVE':
    case 'PAST_DUE': {
      if (t < periodEnd) {
        return subscription.cancelAtPeriodEnd
          ? { state: 'CANCELLED', access: 'ok' }
          : { state: 'ACTIVE', access: 'ok' };
      }
      // Cancelada para o fim do período: sem carência.
      if (subscription.cancelAtPeriodEnd) return { state: 'EXPIRED', access: 'blocked' };
      return t < periodEnd + Math.max(0, graceDays) * DAY_MS
        ? { state: 'PAST_DUE', access: 'grace' }
        : { state: 'EXPIRED', access: 'blocked' };
    }
  }
}

/** Soma `months` meses em UTC a partir de `anchor`, mantendo a hora e o dia (dia 31 vai ao último dia do mês curto). */
export function addMonthsUtc(anchor: Date, months: number): Date {
  const totalMonths = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth() + months;
  const year = Math.floor(totalMonths / 12);
  const month = totalMonths - year * 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(anchor.getUTCDate(), lastDay);
  return new Date(
    Date.UTC(
      year,
      month,
      day,
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  );
}

/**
 * Início da janela mensal de uso que contém `now`: janelas ancoradas no início do período pago (no
 * anual, o mês 1, 2, 3...; o dia 31 cai no último dia do mês curto, sempre contado a partir da âncora, nunca
 * cumulativamente). `windowsInPeriod` limita o índice da janela (mensal = 1: durante a carência o uso segue
 * na janela do período; anual = 12). Antes da âncora, devolve a própria âncora.
 */
export function usageWindowStart(now: Date, periodStart: Date, windowsInPeriod?: number): Date {
  if (now.getTime() <= periodStart.getTime()) return periodStart;
  let index =
    (now.getUTCFullYear() - periodStart.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - periodStart.getUTCMonth());
  if (addMonthsUtc(periodStart, index).getTime() > now.getTime()) index -= 1;
  if (windowsInPeriod !== undefined) index = Math.min(index, Math.max(0, windowsInPeriod - 1));
  return addMonthsUtc(periodStart, Math.max(0, index));
}

/** Fim (exclusivo) da janela que começa em `windowStart`, ancorada no início do período. */
export function usageWindowEnd(windowStart: Date, periodStart: Date): Date {
  const index =
    (windowStart.getUTCFullYear() - periodStart.getUTCFullYear()) * 12 +
    (windowStart.getUTCMonth() - periodStart.getUTCMonth());
  return addMonthsUtc(periodStart, Math.max(0, index) + 1);
}

/** Janelas de uso por período pago: 1 no mensal (e no teste), 12 no anual. */
export function windowsInPeriod(cycle: BillingCycle, status: SubscriptionStatus): number {
  return cycle === 'ANNUAL' && status !== 'TRIAL' ? 12 : 1;
}

/** Janelas de uso do período atual da assinatura (1 no teste; nos pagos, os meses do período, spec 031 E3). */
export function subscriptionWindows(
  subscription: Pick<SubscriptionRecord, 'status' | 'currentPeriodStart' | 'currentPeriodEnd'>,
): number {
  return subscription.status === 'TRIAL'
    ? 1
    : windowsInSpan(subscription.currentPeriodStart, subscription.currentPeriodEnd);
}

export interface QuotaNumbers {
  readonly used: number;
  readonly limit: number;
}

export interface CompanyEntitlements {
  readonly access: AccessLevel;
  readonly agenda: boolean;
  readonly stock: boolean;
  /** `null` = sem limite (cobrança desligada ou sem medição). */
  readonly tokens: QuotaNumbers | null;
  readonly replies: QuotaNumbers | null;
}

/** Sem cobrança nada é limitado: acesso pleno, módulos liberados e nenhuma cota. */
export const UNLIMITED_ENTITLEMENTS: CompanyEntitlements = {
  access: 'ok',
  agenda: true,
  stock: true,
  tokens: null,
  replies: null,
};

export interface UsageNumbers {
  readonly tokens: number;
  readonly sentMessages: number;
  readonly extraReplies: number;
}

export interface QuotaSettings {
  readonly graceDays: number;
  /** Cota de tokens do teste gratuito (`BILLING_TRIAL_TOKENS`). */
  readonly trialTokens: number;
}

/** Cotas efetivas (plano + respostas extras compradas; o teste usa a cota de tokens própria). */
export function quotaLimits(
  subscription: Pick<SubscriptionRecord, 'status' | 'plan'>,
  extraReplies: number,
  settings: Pick<QuotaSettings, 'trialTokens'>,
): { readonly tokens: number; readonly replies: number } {
  const baseTokens =
    subscription.status === 'TRIAL' ? settings.trialTokens : subscription.plan.monthlyTokens;
  return {
    tokens: baseTokens + extraReplies * TOKENS_PER_EXTRA_REPLY,
    replies: subscription.plan.monthlyReplies + extraReplies,
  };
}

/** O que a empresa pode fazer agora, dado o estado da assinatura da conta e o uso da janela atual. */
export function buildEntitlements(
  subscription: SubscriptionRecord,
  usage: UsageNumbers,
  now: Date,
  settings: QuotaSettings,
): CompanyEntitlements {
  const { access } = resolveAccess(subscription, now, settings.graceDays);
  const limits = quotaLimits(subscription, usage.extraReplies, settings);
  return {
    access,
    agenda: subscription.agendaEnabled,
    stock: subscription.stockEnabled,
    tokens: { used: usage.tokens, limit: limits.tokens },
    replies: { used: usage.sentMessages, limit: limits.replies },
  };
}

export type QuotaBlockReason = 'inactive' | 'replies' | 'tokens';

/**
 * Por que a IA não deve responder agora (a cota que estourar primeiro, ou o acesso bloqueado), ou `null`.
 * A cota é verificada ANTES e consumida DEPOIS: um turno pode passar do limite em uma resposta (aceito).
 */
export function quotaBlockReason(entitlements: CompanyEntitlements): QuotaBlockReason | null {
  if (entitlements.access === 'blocked') return 'inactive';
  if (entitlements.replies !== null && entitlements.replies.used >= entitlements.replies.limit) {
    return 'replies';
  }
  if (entitlements.tokens !== null && entitlements.tokens.used >= entitlements.tokens.limit) {
    return 'tokens';
  }
  return null;
}

/** Frações de alerta (80% e 100%) já alcançadas por `used` de `limit`; limite inválido não alerta. */
export function reachedAlertFractions(used: number, limit: number): readonly number[] {
  if (!(limit > 0)) return [];
  return QUOTA_ALERT_FRACTIONS.filter((fraction) => used >= limit * fraction);
}

/** Estimativa do custo da Meta na janela, em milésimos de centavo (estimativa, nunca fatura). */
export function metaEstimateMilliCents(sentMessages: number, perMessageMilliCents: number): number {
  return Math.max(0, sentMessages) * Math.max(0, perMessageMilliCents);
}

/** Preço total do ciclo em centavos, só do catálogo (módulos somados). */
export function priceTotalCents(
  price: Pick<PlanPriceRecord, 'baseCents' | 'agendaCents' | 'stockCents'>,
  modules: { readonly agenda: boolean; readonly stock: boolean },
): number {
  return (
    price.baseCents +
    (modules.agenda ? price.agendaCents : 0) +
    (modules.stock ? price.stockCents : 0)
  );
}

// ---------------------------------------------------------------------------------------------
// Checkout (spec 031, E3): regras puras de pedido e de extensão do período pago.
// ---------------------------------------------------------------------------------------------

/** Meses de cada ciclo de cobrança. */
export const CYCLE_MONTHS: Readonly<Record<BillingCycle, number>> = { MONTHLY: 1, ANNUAL: 12 };

/** Validade do pedido (e do link) a partir da criação: 24 h (spec 031). */
export const ORDER_VALIDITY_MS = 24 * 3_600_000;
/** Teto de pedidos criados por assinatura em 24 h (defesa contra abuso do provedor). */
export const ORDER_MAX_PER_DAY = 10;
/** A reconciliação só olha pedidos criados nesta janela (48 h). */
export const RECONCILE_WINDOW_MS = 48 * 3_600_000;
/** Valor mínimo de um link da InfinitePay, em centavos (R$ 1,00). */
export const CHECKOUT_MIN_AMOUNT_CENTS = 100;

/** O que o pedido cobra, copiado do catálogo no momento da criação (nada vem do navegador). */
export interface OrderBreakdown {
  readonly planCode: PlanCode;
  readonly cycle: BillingCycle;
  readonly agenda: boolean;
  readonly stock: boolean;
  readonly priceId: string;
  readonly priceVersion: number;
  readonly whatsappBillingMode: WhatsappBillingMode;
}

/**
 * Quantas janelas mensais de uso cabem no período [start, end): o maior k com start + k meses <= end
 * (no mínimo 1). Serve ao mensal estendido por renovação antecipada (2 meses = 2 janelas) e ao anual (12).
 * O teste gratuito (poucos dias) tem 1 janela.
 */
export function windowsInSpan(periodStart: Date, periodEnd: Date): number {
  let months = 0;
  while (months < 600 && addMonthsUtc(periodStart, months + 1).getTime() <= periodEnd.getTime()) {
    months += 1;
  }
  return Math.max(1, months);
}

export interface PaidPeriod {
  readonly periodStart: Date;
  readonly periodEnd: Date;
  /** Verdadeiro quando o pagamento continua o período vigente (renovação) em vez de recomeçar em now. */
  readonly continuing: boolean;
}

/**
 * Período resultante de um pagamento aprovado. Renovação dentro do período, ou paga na carência, SOMA a
 * partir do fim atual (âncora no início do período, sem deriva de dia); teste, assinatura bloqueada ou
 * cancelada já vencida recomeçam em now. Pura, relógio injetado.
 */
export function computePaidPeriod(
  current: Pick<
    SubscriptionRecord,
    'status' | 'currentPeriodStart' | 'currentPeriodEnd' | 'trialEndsAt' | 'cancelAtPeriodEnd'
  >,
  now: Date,
  graceDays: number,
  cycle: BillingCycle,
): PaidPeriod {
  const resolved = resolveAccess(current, now, graceDays);
  const continuing =
    current.status !== 'TRIAL' &&
    current.status !== 'EXPIRED' &&
    resolved.access !== 'blocked' &&
    (resolved.state === 'ACTIVE' ||
      resolved.state === 'PAST_DUE' ||
      resolved.state === 'CANCELLED');
  if (!continuing) {
    return {
      periodStart: now,
      periodEnd: addMonthsUtc(now, CYCLE_MONTHS[cycle]),
      continuing: false,
    };
  }
  const months = windowsInSpan(current.currentPeriodStart, current.currentPeriodEnd);
  return {
    periodStart: current.currentPeriodStart,
    periodEnd: addMonthsUtc(current.currentPeriodStart, months + CYCLE_MONTHS[cycle]),
    continuing: true,
  };
}
