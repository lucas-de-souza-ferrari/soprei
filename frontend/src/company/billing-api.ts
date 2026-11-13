import { z } from 'zod';
import { ApiError, request } from '../api';

/**
 * Contratos e mensagens da tela de Assinatura (spec 031, E4). Todo dinheiro chega do servidor em centavos
 * inteiros; o navegador nunca calcula preço, desconto nem proporcional. Mensagens de erro são escolhidas aqui
 * pelo `status` e pelo `error.code`; o texto de erro do servidor nunca é lido nem exibido.
 */
const isoDate = z.iso.datetime();
const cents = z.number().int().min(0);

export const PLAN_CODES = ['ESSENTIAL', 'PROFESSIONAL', 'SCALE'] as const;
export type PlanCode = (typeof PLAN_CODES)[number];
export const CYCLES = ['MONTHLY', 'ANNUAL'] as const;
export type Cycle = (typeof CYCLES)[number];

const pendingChangeSchema = z.object({
  planCode: z.enum(PLAN_CODES),
  cycle: z.enum(CYCLES),
  agenda: z.boolean(),
  stock: z.boolean(),
});
export type PendingChange = z.infer<typeof pendingChangeSchema>;

const subscriptionSchema = z.object({
  planCode: z.enum(PLAN_CODES),
  planName: z.string().max(80),
  cycle: z.enum(CYCLES),
  agenda: z.boolean(),
  stock: z.boolean(),
  status: z.enum(['TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED']),
  access: z.enum(['ok', 'grace', 'blocked']),
  currentPeriodStart: isoDate,
  currentPeriodEnd: isoDate,
  graceEndsAt: isoDate,
  trialEndsAt: isoDate.nullable(),
  cancelAtPeriodEnd: z.boolean(),
  pendingChange: pendingChangeSchema.nullable(),
  maxCompanies: z.number().int().min(0),
  companies: z.number().int().min(0),
  whatsappBillingMode: z.enum(['CUSTOMER_PAYS_META', 'SOPREI_PAYS_META']),
  whatsappNotice: z.enum(['NOT_INCLUDED', 'INCLUDED_UP_TO_REPLIES']),
});
export type Subscription = z.infer<typeof subscriptionSchema>;

const quotaSchema = z.object({ used: z.number().min(0), limit: z.number().min(0) });

export const ORDER_KINDS = ['NEW', 'RENEWAL', 'UPGRADE', 'EXTRA_PACK'] as const;
export const ORDER_STATUSES = ['PENDING', 'PAID', 'EXPIRED', 'FAILED'] as const;
export const orderSchema = z.object({
  id: z.uuid(),
  kind: z.enum(ORDER_KINDS),
  status: z.enum(ORDER_STATUSES),
  amountCents: cents,
  createdAt: isoDate,
  paidAt: isoDate.nullable(),
});
export type OrderRow = z.infer<typeof orderSchema>;

const priceSchema = z.object({
  cycle: z.enum(CYCLES),
  baseCents: cents,
  agendaCents: cents,
  stockCents: cents,
  whatsappBillingMode: z.enum(['CUSTOMER_PAYS_META', 'SOPREI_PAYS_META']),
  /**
   * Preço por resposta incluída, em milésimos de centavo, calculado pelo servidor (spec 040, D9). Opcional
   * (servidor anterior não o envia); 0 ou ausente = a linha não aparece. O navegador só formata.
   */
  perReplyMilliCents: z.number().int().min(0).optional(),
});
const catalogPlanSchema = z.object({
  code: z.enum(PLAN_CODES),
  name: z.string().max(80),
  maxCompanies: z.number().int().min(0),
  monthlyTokens: z.number().min(0),
  monthlyReplies: z.number().int().min(0),
  prices: z.array(priceSchema).max(4),
});
export type CatalogPlan = z.infer<typeof catalogPlanSchema>;

export const billingSchema = z.object({
  subscription: subscriptionSchema.nullable(),
  usage: z
    .object({
      windowStart: isoDate,
      windowEnd: isoDate,
      tokens: quotaSchema,
      replies: quotaSchema,
      metaEstimate: z.object({ isEstimate: z.literal(true), milliCents: z.number().min(0) }),
    })
    .nullable(),
  orders: z.array(orderSchema).max(50),
  catalog: z.array(catalogPlanSchema).max(10),
  trial: z.object({ available: z.boolean(), days: z.number().int().min(0) }),
  checkoutEnabled: z.boolean(),
  /** Host do link de pagamento: o site só abre links deste host (defesa em profundidade). */
  checkoutHost: z.string().max(253).nullable().default(null),
});
export type Billing = z.infer<typeof billingSchema>;

export const quoteSchema = z.object({
  kind: z.enum(['NEW', 'RENEWAL', 'UPGRADE', 'DOWNGRADE', 'CYCLE_CHANGE']),
  amountCents: cents,
  effective: z.enum(['now', 'next_renewal']),
  periodEnd: isoDate.nullable(),
  remainingDays: z.number().int().min(0).nullable(),
});
export type Quote = z.infer<typeof quoteSchema>;

const createdOrderSchema = z.object({
  orderId: z.uuid(),
  checkoutUrl: z.string().max(2048),
  amountCents: cents,
  expiresAt: isoDate,
});
export type CreatedOrder = z.infer<typeof createdOrderSchema>;

const checkSchema = z.object({
  outcome: z.enum(['paid', 'failed', 'unavailable', 'pending']),
  order: orderSchema,
});
export type CheckResult = z.infer<typeof checkSchema>;

const changeStateSchema = z.object({
  cancelAtPeriodEnd: z.boolean(),
  pendingChange: pendingChangeSchema.nullable(),
});

/** Escolha de plano: só a escolha (o servidor calcula o resto). */
export interface Selection {
  readonly planCode: PlanCode;
  readonly cycle: Cycle;
  readonly agenda: boolean;
  readonly stock: boolean;
}

/** Referências do retorno do checkout: só ids curtos validados, usados como dica do "Já paguei". */
export interface CheckHints {
  readonly transactionNsu?: string | undefined;
  readonly slug?: string | undefined;
}

const orderPath = (orderId: string): string => `/account/billing/orders/${orderId}/check`;

export const billingApi = {
  overview: async (): Promise<Billing> => billingSchema.parse(await request('/account/billing')),
  quote: async (selection: Selection): Promise<Quote> => {
    const query = new URLSearchParams({
      planCode: selection.planCode,
      cycle: selection.cycle,
      agenda: String(selection.agenda),
      stock: String(selection.stock),
    });
    return quoteSchema.parse(await request(`/account/billing/quote?${query.toString()}`));
  },
  createOrder: async (selection: Selection): Promise<CreatedOrder> =>
    createdOrderSchema.parse(
      await request('/account/billing/orders', { method: 'POST', body: selection }),
    ),
  upgrade: async (selection: Selection): Promise<CreatedOrder> =>
    createdOrderSchema.parse(
      await request('/account/billing/plan-change', {
        method: 'POST',
        body: {
          action: 'upgrade',
          planCode: selection.planCode,
          agenda: selection.agenda,
          stock: selection.stock,
        },
      }),
    ),
  schedule: async (selection: Selection) =>
    changeStateSchema.parse(
      await request('/account/billing/plan-change', {
        method: 'POST',
        body: { action: 'downgrade', ...selection },
      }),
    ),
  undoPending: async () =>
    changeStateSchema.parse(
      await request('/account/billing/plan-change', {
        method: 'POST',
        body: { action: 'undo_pending' },
      }),
    ),
  cancel: async () =>
    changeStateSchema.parse(
      await request('/account/billing/plan-change', { method: 'POST', body: { action: 'cancel' } }),
    ),
  reactivate: async () =>
    changeStateSchema.parse(
      await request('/account/billing/plan-change', {
        method: 'POST',
        body: { action: 'reactivate' },
      }),
    ),
  check: async (orderId: string, hints: CheckHints = {}): Promise<CheckResult> =>
    checkSchema.parse(
      await request(orderPath(orderId), {
        method: 'POST',
        body: {
          ...(hints.transactionNsu === undefined ? {} : { transactionNsu: hints.transactionNsu }),
          ...(hints.slug === undefined ? {} : { slug: hints.slug }),
        },
      }),
    ),
};

/** O que fazer com uma falha: voltar ao login ou mostrar uma mensagem escolhida pelo site. */
export type BillingFailure =
  | { readonly kind: 'session' }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'message'; readonly code: string | undefined; readonly text: string };

export const BILLING_GENERIC = 'Não foi possível concluir. Tente novamente.';

const CODE_MESSAGES: Readonly<Record<string, string>> = {
  NO_SUBSCRIPTION:
    'Crie a primeira empresa para começar o teste gratuito antes de escolher um plano.',
  PLAN_DOWNGRADE_BLOCKED:
    'Você tem mais empresas do que este plano comporta. Reduza o número de empresas ou escolha um plano maior.',
  PLAN_CHANGE_UNAVAILABLE:
    'Não há um plano pago em vigor para trocar agora. Renove a assinatura ou escolha um plano.',
  PENDING_CHANGE_EXISTS: 'Há uma troca agendada. Desfaça-a antes de continuar.',
  UPGRADE_TOO_LATE:
    'Falta menos de um dia para o fim do período. Renove e troque de plano na renovação.',
  CYCLE_CHANGE_ON_RENEWAL: 'O ciclo (mensal ou anual) só muda na renovação.',
  NO_CHANGE: 'Escolha um plano ou módulos diferentes dos atuais.',
  NOT_AN_UPGRADE: 'Escolha um plano ou módulos diferentes dos atuais.',
  USE_UPGRADE: 'Esta escolha aumenta o plano: use a opção de pagar a diferença.',
  USE_PLAN_CHANGE: 'Esta escolha muda o plano durante o ciclo: use o botão da troca.',
  ORDER_LIMIT_REACHED: 'Você já criou muitos pedidos hoje. Tente novamente amanhã.',
  CHECKOUT_UNAVAILABLE: 'O pagamento está indisponível no momento. Tente novamente em instantes.',
};

/** Traduz uma falha da API em ação de tela. Ignora por completo o texto do corpo de erro. */
export function billingFailure(error: unknown): BillingFailure {
  if (!(error instanceof ApiError))
    return { kind: 'message', code: undefined, text: BILLING_GENERIC };
  const { status, code } = error;
  if (status === 401) return { kind: 'session' };
  if (status === 404) return { kind: 'disabled' };
  const known = code === undefined ? undefined : CODE_MESSAGES[code];
  if (known !== undefined) return { kind: 'message', code, text: known };
  if (status === 403) {
    return { kind: 'message', code, text: 'Você não tem permissão para esta ação.' };
  }
  if (status === 429) {
    return {
      kind: 'message',
      code,
      text: 'Muitas tentativas. Aguarde antes de tentar novamente.',
    };
  }
  if (status === 502 || status === 503) {
    return {
      kind: 'message',
      code,
      text: 'O serviço de pagamento está indisponível. Tente novamente em instantes.',
    };
  }
  return { kind: 'message', code, text: BILLING_GENERIC };
}

// ---------------------------------------------------------------------------------------------
// Acesso da empresa (qualquer papel): sem dinheiro. Serve à faixa de estado e às abas por módulo.
// ---------------------------------------------------------------------------------------------

export const entitlementsSchema = z.object({
  access: z.enum(['ok', 'grace', 'blocked']),
  agenda: z.boolean(),
  stock: z.boolean(),
  tokens: quotaSchema.nullable(),
  replies: quotaSchema.nullable(),
  /** A conta logada é a titular da assinatura DESTA empresa (a tela de Assinatura é da conta). */
  holder: z.boolean().default(false),
});
export type Entitlements = z.infer<typeof entitlementsSchema>;

/**
 * Lê o acesso da empresa. Falha 4xx (cobrança desligada, sem acesso) vira `null`: sem leitura nada é escondido
 * nem bloqueado pelo site (o backend é quem barra de verdade). Falha transitória (5xx, rede) é repetida uma vez
 * antes de desistir, para o item Assinatura não sumir por um soluço do servidor.
 */
export async function loadEntitlements(companyId: string): Promise<Entitlements | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return entitlementsSchema.parse(await request(`/admin/companies/${companyId}/entitlements`));
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) return null;
    }
  }
  return null;
}
