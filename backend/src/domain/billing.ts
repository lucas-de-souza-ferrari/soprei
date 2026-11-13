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

/** Troca agendada para a PRÓXIMA renovação (downgrade, retirada de módulo ou mudança de ciclo). */
export interface PendingChange {
  readonly planCode: PlanCode;
  readonly cycle: BillingCycle;
  readonly agenda: boolean;
  readonly stock: boolean;
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
  /** Troca para a próxima renovação (nulo = nenhuma). */
  readonly pendingChange: PendingChange | null;
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
  /** Cota de respostas do teste gratuito (`BILLING_TRIAL_REPLIES`, spec 040 D8), limitada à do plano. */
  readonly trialReplies: number;
}

/**
 * Cotas efetivas (plano + respostas extras compradas). O teste gratuito usa as cotas próprias: tokens =
 * `trialTokens`, respostas = o menor entre `trialReplies` e a cota do plano (spec 040, D8).
 */
export function quotaLimits(
  subscription: Pick<SubscriptionRecord, 'status' | 'plan'>,
  extraReplies: number,
  settings: Pick<QuotaSettings, 'trialTokens' | 'trialReplies'>,
): { readonly tokens: number; readonly replies: number } {
  const trial = subscription.status === 'TRIAL';
  const baseTokens = trial ? settings.trialTokens : subscription.plan.monthlyTokens;
  const baseReplies = trial
    ? Math.min(settings.trialReplies, subscription.plan.monthlyReplies)
    : subscription.plan.monthlyReplies;
  return {
    tokens: baseTokens + extraReplies * TOKENS_PER_EXTRA_REPLY,
    replies: baseReplies + extraReplies,
  };
}

/** As duas cotas mensais de uma linha de `Plan` (respostas e tokens). */
export interface PlanQuotas {
  readonly monthlyReplies: number;
  readonly monthlyTokens: number;
}

/**
 * Regra do máximo (spec 040, D4): para cada cota, o MAIOR valor entre a linha de `Plan` da assinatura
 * (`own`) e a versão ativa mais nova do mesmo código (`current`). Assim um catálogo mais generoso vale na
 * hora para quem já assina, e uma versão futura com cota menor nunca reduz a de quem já pagou (só vale quando
 * a assinatura renovar e a concessão gravar a linha nova). Sem `current` (catálogo sem o código), fica a própria.
 */
export function effectiveQuotas(
  own: PlanQuotas,
  current: PlanQuotas | null | undefined,
): PlanQuotas {
  if (current === null || current === undefined) {
    return { monthlyReplies: own.monthlyReplies, monthlyTokens: own.monthlyTokens };
  }
  return {
    monthlyReplies: Math.max(own.monthlyReplies, current.monthlyReplies),
    monthlyTokens: Math.max(own.monthlyTokens, current.monthlyTokens),
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

/**
 * Preço por resposta incluída, em milésimos de centavo, arredondado para baixo (spec 040, D9): o preço do
 * plano (sem módulos) dividido pelas respostas do ciclo inteiro (mensal = 1 mês de cota; anual = 12).
 * Cota inválida devolve 0 (nada é exibido como "de graça" por engano: a tela trata 0 como ausente).
 */
export function perReplyMilliCents(
  baseCents: number,
  monthlyReplies: number,
  cycle: BillingCycle,
): number {
  const replies = monthlyReplies * CYCLE_MONTHS[cycle];
  if (!(replies > 0) || !(baseCents > 0)) return 0;
  return Math.floor((baseCents * 1000) / replies);
}

/** Uma entrada do catálogo vigente, só com o que as regras puras precisam (estrutural, sem repositório). */
export interface CatalogLike {
  readonly plan: Pick<PlanRecord, 'code'> & { readonly name?: string };
  readonly prices: readonly Pick<
    PlanPriceRecord,
    'cycle' | 'baseCents' | 'agendaCents' | 'stockCents'
  >[];
}

export interface RenewalPriceChange {
  /** Total da seleção que vai renovar ao preço da versão que a assinatura paga (`sub.price`). */
  readonly currentCents: number;
  /** Total da MESMA seleção ao preço vigente do catálogo. */
  readonly nextCents: number;
  /** Nome do plano da renovação no catálogo vigente (para o e-mail), quando o catálogo o traz. */
  readonly planName?: string | undefined;
}

/**
 * Reajuste da próxima renovação (spec 040, D6, revisada): compara a MESMA seleção (plano, ciclo e módulos que
 * vão renovar) ao preço da versão que a assinatura paga (`sub.price`) contra o preço vigente do catálogo. Uma
 * troca escolhida pela pessoa (troca agendada para outro plano ou outro ciclo) nunca é reajuste: devolve
 * `null`. Troca agendada que só tira ou põe módulo no mesmo plano e ciclo compara os módulos da renovação nas
 * duas versões. `null` também se o catálogo não tem o plano ou o ciclo.
 */
export function renewalPriceChange(
  subscription: Pick<
    SubscriptionRecord,
    'plan' | 'price' | 'cycle' | 'agendaEnabled' | 'stockEnabled' | 'pendingChange'
  >,
  catalog: readonly CatalogLike[],
): RenewalPriceChange | null {
  const next: PlanSelection = subscription.pendingChange ?? {
    planCode: subscription.plan.code,
    cycle: subscription.cycle,
    agenda: subscription.agendaEnabled,
    stock: subscription.stockEnabled,
  };
  if (next.planCode !== subscription.plan.code || next.cycle !== subscription.cycle) return null;
  const entry = catalog.find((candidate) => candidate.plan.code === next.planCode);
  const price = entry?.prices.find((candidate) => candidate.cycle === next.cycle);
  if (entry === undefined || price === undefined) return null;
  const modules = { agenda: next.agenda, stock: next.stock };
  return {
    currentCents: priceTotalCents(subscription.price, modules),
    nextCents: priceTotalCents(price, modules),
    planName: entry.plan.name,
  };
}

/** A próxima renovação custa MAIS que o preço que a assinatura paga hoje? (Aviso de reajuste, D6.) */
export function renewalPriceIncrease(
  subscription: Parameters<typeof renewalPriceChange>[0],
  catalog: readonly CatalogLike[],
): boolean {
  const change = renewalPriceChange(subscription, catalog);
  return change !== null && change.nextCents > change.currentCents;
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
  /**
   * Só no UPGRADE: a assinatura como era quando o pedido foi criado. Se o plano, os módulos ou o período
   * mudarem antes do pagamento, o pedido NÃO concede (revisão manual/estorno).
   */
  readonly upgradeBase?: UpgradeBase;
}

export interface UpgradeBase {
  readonly planCode: PlanCode;
  readonly cycle: BillingCycle;
  readonly agenda: boolean;
  readonly stock: boolean;
  /** Início e fim do período pago (ISO UTC). */
  readonly periodStart: string;
  readonly periodEnd: string;
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

// ---------------------------------------------------------------------------------------------
// Troca de plano no meio do ciclo (spec 031, E3 estendida; D11): regras puras.
// ---------------------------------------------------------------------------------------------

/** Ordem dos planos (o maior comporta mais empresas e mais cota). */
export const PLAN_RANK: Readonly<Record<PlanCode, number>> = {
  ESSENTIAL: 1,
  PROFESSIONAL: 2,
  SCALE: 3,
};

/** Menos que isto de período restante: o upgrade é recusado e a pessoa é orientada a renovar. */
export const UPGRADE_MIN_REMAINING_MS = DAY_MS;

export interface PlanSelection {
  readonly planCode: PlanCode;
  readonly cycle: BillingCycle;
  readonly agenda: boolean;
  readonly stock: boolean;
}

export type ChangeRelation = 'same' | 'up' | 'down' | 'mixed' | 'cycle';

/**
 * Como a escolha se compara com a assinatura atual. 'up': mesmo ciclo, plano igual ou maior, módulos que
 * contêm os atuais e ao menos um a mais. 'down': o inverso. 'mixed': um sobe e outro desce. 'cycle': o ciclo
 * muda (só na renovação).
 */
export function classifyChange(current: PlanSelection, target: PlanSelection): ChangeRelation {
  const planDelta = PLAN_RANK[target.planCode] - PLAN_RANK[current.planCode];
  const agendaDelta = Number(target.agenda) - Number(current.agenda);
  const stockDelta = Number(target.stock) - Number(current.stock);
  if (target.cycle !== current.cycle) return 'cycle';
  const deltas = [planDelta, agendaDelta, stockDelta];
  const up = deltas.some((delta) => delta > 0);
  const down = deltas.some((delta) => delta < 0);
  if (up && down) return 'mixed';
  if (up) return 'up';
  if (down) return 'down';
  return 'same';
}

export function samePlanSelection(a: PlanSelection, b: PlanSelection): boolean {
  return (
    a.planCode === b.planCode && a.cycle === b.cycle && a.agenda === b.agenda && a.stock === b.stock
  );
}

export type ProrationResult =
  | {
      readonly ok: true;
      readonly cents: number;
      readonly remainingMs: number;
      readonly totalMs: number;
    }
  | { readonly ok: false; readonly reason: 'no_increase' | 'not_in_period' | 'too_late' };

/**
 * Diferença proporcional de um upgrade: (preço do ciclo novo menos o atual) x fração restante do período
 * pago, em centavos inteiros, aritmética inteira (BigInt), arredondando PARA CIMA e com piso de R$ 1,00
 * (mínimo do link). Período estendido por renovações antecipadas conta várias vezes a diferença do ciclo
 * (a fração é sobre o período inteiro). Menos de 1 dia restante: 'too_late'. Pura, now injetado.
 */
export function prorateUpgradeCents(input: {
  readonly currentTotalCents: number;
  readonly newTotalCents: number;
  readonly cycle: BillingCycle;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly now: Date;
}): ProrationResult {
  const diff = input.newTotalCents - input.currentTotalCents;
  if (!(diff > 0)) return { ok: false, reason: 'no_increase' };
  const totalMs = input.periodEnd.getTime() - input.periodStart.getTime();
  const remainingMs = input.periodEnd.getTime() - input.now.getTime();
  if (!(totalMs > 0) || remainingMs <= 0 || input.now.getTime() < input.periodStart.getTime()) {
    return { ok: false, reason: 'not_in_period' };
  }
  if (remainingMs < UPGRADE_MIN_REMAINING_MS) return { ok: false, reason: 'too_late' };
  const cycles = Math.max(
    1,
    Math.round(windowsInSpan(input.periodStart, input.periodEnd) / CYCLE_MONTHS[input.cycle]),
  );
  const numerator = BigInt(diff) * BigInt(cycles) * BigInt(remainingMs);
  const denominator = BigInt(totalMs);
  const cents = Number((numerator + denominator - 1n) / denominator);
  return {
    ok: true,
    cents: Math.max(cents, CHECKOUT_MIN_AMOUNT_CENTS),
    remainingMs,
    totalMs,
  };
}
