import {
  type BillingRepository,
  type CatalogEntry,
  metaEstimateMilliCents,
  type OrderSummary,
  type PlanPriceRecord,
  quotaLimits,
  resolveAccess,
  type SubscriptionRecord,
  type SubscriptionStatus,
  usageWindowEnd,
  subscriptionWindows,
  usageWindowStart,
  type AccessLevel,
  type WhatsappBillingMode,
} from '../../domain/index.js';

export interface BillingServiceSettings {
  readonly graceDays: number;
  readonly trialDays: number;
  readonly trialTokens: number;
  /** `SOPREI_PAYS_META_ENABLED`: sem ela o modo S não aparece na tela nem vale na leitura. */
  readonly allowSopreiPaysMeta: boolean;
}

export interface BillingOverview {
  /** `null`: a conta ainda não tem assinatura (o teste gratuito nasce ao criar a primeira empresa). */
  readonly subscription: {
    readonly planCode: SubscriptionRecord['plan']['code'];
    readonly planName: string;
    readonly cycle: SubscriptionRecord['cycle'];
    readonly agenda: boolean;
    readonly stock: boolean;
    readonly status: SubscriptionStatus;
    readonly access: AccessLevel;
    readonly currentPeriodStart: Date;
    readonly currentPeriodEnd: Date;
    readonly trialEndsAt: Date | null;
    readonly cancelAtPeriodEnd: boolean;
    readonly maxCompanies: number;
    readonly companies: number;
    readonly whatsappBillingMode: WhatsappBillingMode;
    /** O aviso fixo que a tela mostra: o plano inclui ou não o custo das mensagens do WhatsApp. */
    readonly whatsappNotice: 'NOT_INCLUDED' | 'INCLUDED_UP_TO_REPLIES';
  } | null;
  readonly usage: {
    readonly windowStart: Date;
    readonly windowEnd: Date;
    readonly tokens: { readonly used: number; readonly limit: number };
    readonly replies: { readonly used: number; readonly limit: number };
    /** Só uma ESTIMATIVA (a fatura real vem da Meta); em milésimos de centavo. */
    readonly metaEstimate: { readonly isEstimate: true; readonly milliCents: number };
  } | null;
  readonly orders: readonly OrderSummary[];
  readonly catalog: readonly CatalogEntry[];
  readonly trial: { readonly available: boolean; readonly days: number };
}

/**
 * Leitura da cobrança da conta (spec 031, E1). Só lê: o teste gratuito nasce na criação da primeira
 * empresa (ou na adoção de uma empresa existente ao ligar a cobrança), nunca por um `GET`. Preço e
 * cota saem sempre do catálogo no servidor.
 */
export class BillingService {
  constructor(
    private readonly deps: {
      readonly billing: BillingRepository;
      readonly settings: BillingServiceSettings;
      readonly now?: () => Date;
    },
  ) {}

  async overview(accountId: string): Promise<BillingOverview> {
    const { billing, settings } = this.deps;
    const now = this.deps.now?.() ?? new Date();
    const [subscription, catalog, orders] = await Promise.all([
      billing.findSubscription(accountId),
      billing.catalog(now, settings.allowSopreiPaysMeta),
      billing.listOrders(accountId, 10),
    ]);
    if (subscription === null) {
      return {
        subscription: null,
        usage: null,
        orders,
        catalog,
        trial: { available: true, days: settings.trialDays },
      };
    }
    const { state, access } = resolveAccess(subscription, now, settings.graceDays);
    const windows = subscriptionWindows(subscription);
    const windowStart = usageWindowStart(now, subscription.currentPeriodStart, windows);
    const [usage, companies] = await Promise.all([
      billing.usage(accountId, windowStart),
      billing.countCompanies(accountId),
    ]);
    const limits = quotaLimits(subscription, usage.extraReplies, settings);
    const mode = subscription.price.whatsappBillingMode;
    return {
      subscription: {
        planCode: subscription.plan.code,
        planName: subscription.plan.name,
        cycle: subscription.cycle,
        agenda: subscription.agendaEnabled,
        stock: subscription.stockEnabled,
        status: state,
        access,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        trialEndsAt: subscription.trialEndsAt,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        maxCompanies: subscription.plan.maxCompanies,
        companies,
        whatsappBillingMode: mode,
        whatsappNotice: mode === 'SOPREI_PAYS_META' ? 'INCLUDED_UP_TO_REPLIES' : 'NOT_INCLUDED',
      },
      usage: {
        windowStart,
        windowEnd: usageWindowEnd(windowStart, subscription.currentPeriodStart),
        tokens: { used: usage.tokens, limit: limits.tokens },
        replies: { used: usage.sentMessages, limit: limits.replies },
        metaEstimate: {
          isEstimate: true,
          milliCents: metaEstimateMilliCents(
            usage.sentMessages,
            subscription.plan.metaEstimateMilliCents,
          ),
        },
      },
      orders,
      catalog,
      trial: { available: false, days: settings.trialDays },
    };
  }
}

export type { PlanPriceRecord };
