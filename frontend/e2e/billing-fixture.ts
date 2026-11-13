import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { SENTINEL, type Call, type FakeApi } from './company-fixture';

/**
 * API falsa da Assinatura (spec 031, E4): camada por cima da API falsa da área da empresa (`page.route`
 * registrado depois vale primeiro; o resto segue por `route.fallback()`). O "servidor" daqui calcula as
 * cotações com números fixos (o navegador não calcula nada) e a página do checkout é um HTML falso. Nada sai
 * para a internet.
 */
export type Status = 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'CANCELLED' | 'EXPIRED';

export interface FakeSubscription {
  planCode: 'ESSENTIAL' | 'PROFESSIONAL' | 'SCALE';
  cycle: 'MONTHLY' | 'ANNUAL';
  agenda: boolean;
  stock: boolean;
  status: Status;
  access: 'ok' | 'grace' | 'blocked';
  /** Dias a partir de agora até o vencimento (negativo = já venceu). */
  endsInDays: number;
  cancelAtPeriodEnd: boolean;
  pendingChange: {
    planCode: FakeSubscription['planCode'];
    cycle: FakeSubscription['cycle'];
    agenda: boolean;
    stock: boolean;
  } | null;
  companies: number;
}

export interface FakeOrder {
  id: string;
  kind: 'NEW' | 'RENEWAL' | 'UPGRADE' | 'EXTRA_PACK';
  status: 'PENDING' | 'PAID' | 'EXPIRED' | 'FAILED';
  amountCents: number;
  createdAt: string;
  paidAt: string | null;
}

export interface FakeBilling {
  /** `false` = a cobrança está desligada (`GET /account/billing` responde 404). */
  enabled: boolean;
  checkoutEnabled: boolean;
  /** A conta logada é a titular da assinatura DA EMPRESA aberta (padrão: tem assinatura própria). */
  holder?: boolean | undefined;
  /** `null` = a conta não tem assinatura própria (quem entrou por convite). */
  sub: FakeSubscription | null;
  /** `tokens` só existe na API (proteção de custo); a tela não o mostra (spec 040). */
  usage: { replies: [number, number]; tokens: [number, number]; milliCents: number };
  /**
   * Preço por resposta que o "servidor" devolve no catálogo (milésimos de centavo, por plano e ciclo). O teste
   * troca o valor e a tela acompanha: prova de que o navegador não o calcula (spec 040, D9).
   */
  perReply?: Partial<Record<'ESSENTIAL' | 'PROFESSIONAL' | 'SCALE', [number, number]>> | undefined;
  orders: FakeOrder[];
  /** Acesso entregue em `GET .../entitlements` (`undefined` = deriva da assinatura). */
  access?: { access: 'ok' | 'grace' | 'blocked'; agenda: boolean; stock: boolean } | undefined;
  /** Resultados dos próximos "Já paguei" (o último se repete). */
  checks: ('paid' | 'pending' | 'failed')[];
  quoteError: { status: number; code: string } | null;
  calls: Call[];
  /** Pedidos criados (ids) na ordem. */
  created: string[];
}

// Catálogo vigente da spec 040 (anual = 10 x o mensal; preço por resposta calculado pelo servidor).
const PLANS = [
  {
    code: 'ESSENTIAL',
    name: 'Essencial',
    maxCompanies: 1,
    replies: 2500,
    base: [4790, 47900],
    agenda: [2900, 29000],
    stock: [1900, 19000],
    perReply: [1916, 1596],
  },
  {
    code: 'PROFESSIONAL',
    name: 'Profissional',
    maxCompanies: 3,
    replies: 8000,
    base: [11990, 119900],
    agenda: [4900, 49000],
    stock: [3900, 39000],
    perReply: [1498, 1248],
  },
  {
    code: 'SCALE',
    name: 'Escala',
    maxCompanies: 10,
    replies: 30000,
    base: [34900, 349000],
    agenda: [9900, 99000],
    stock: [7900, 79000],
    perReply: [1163, 969],
  },
] as const;
const RANK = { ESSENTIAL: 1, PROFESSIONAL: 2, SCALE: 3 } as const;
export const CHECKOUT_HOST = 'https://checkout.exemplo.test';
const DAY = 86_400_000;

export function newBilling(overrides: Partial<FakeBilling> = {}): FakeBilling {
  return {
    enabled: true,
    checkoutEnabled: true,
    sub: {
      planCode: 'ESSENTIAL',
      cycle: 'MONTHLY',
      agenda: true,
      stock: false,
      status: 'ACTIVE',
      access: 'ok',
      endsInDays: 20,
      cancelAtPeriodEnd: false,
      pendingChange: null,
      companies: 1,
    },
    usage: { replies: [120, 2500], tokens: [600_000, 15_000_000], milliCents: 420_000 },
    orders: [],
    checks: ['paid'],
    quoteError: null,
    calls: [],
    created: [],
    ...overrides,
  };
}

const index = (cycle: 'MONTHLY' | 'ANNUAL'): 0 | 1 => (cycle === 'MONTHLY' ? 0 : 1);

function total(selection: {
  planCode: keyof typeof RANK;
  cycle: 'MONTHLY' | 'ANNUAL';
  agenda: boolean;
  stock: boolean;
}): number {
  const plan = PLANS.find((item) => item.code === selection.planCode) ?? PLANS[0];
  const i = index(selection.cycle);
  return (
    plan.base[i] + (selection.agenda ? plan.agenda[i] : 0) + (selection.stock ? plan.stock[i] : 0)
  );
}

const iso = (offsetDays: number): string => new Date(Date.now() + offsetDays * DAY).toISOString();

export async function installBillingApi(
  page: Page,
  api: FakeApi,
  state: FakeBilling,
): Promise<void> {
  // A página de pagamento falsa (o site só a abre se o link for https).
  await page.route(`${CHECKOUT_HOST}/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>Pagamento falso</title><p>Pagamento falso</p>',
    }),
  );
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api', '');
    const method = request.method();
    const isBilling = path.startsWith('/account/billing');
    const entitlementsMatch = /^\/admin\/companies\/([^/]+)\/entitlements$/.exec(path);
    if (!isBilling && entitlementsMatch === null) return route.fallback();
    const body: unknown = method === 'GET' ? undefined : request.postDataJSON();
    state.calls.push({ method, path: path + url.search, body });
    const reply = (status: number, json?: unknown) =>
      route.fulfill({ status, ...(json === undefined ? {} : { json }) });
    const fail = (status: number, code: string) =>
      reply(status, { error: { code, message: SENTINEL, requestId: 'x' } });

    if (entitlementsMatch !== null) {
      if (!state.enabled) return fail(404, 'NOT_FOUND');
      if (entitlementsMatch[1] !== api.selected) return fail(404, 'NOT_FOUND');
      const sub = state.sub;
      const access = state.access ?? {
        access: sub?.access ?? 'ok',
        agenda: sub?.agenda ?? true,
        stock: sub?.stock ?? true,
      };
      return reply(200, {
        ...access,
        holder: state.holder ?? sub !== null,
        tokens: { used: state.usage.tokens[0], limit: state.usage.tokens[1] },
        replies: { used: state.usage.replies[0], limit: state.usage.replies[1] },
      });
    }

    if (!state.enabled) return fail(404, 'NOT_FOUND');
    const sub = state.sub;

    if (path === '/account/billing' && method === 'GET') {
      return reply(200, {
        subscription:
          sub === null
            ? null
            : {
                planCode: sub.planCode,
                planName: PLANS.find((item) => item.code === sub.planCode)?.name ?? 'Essencial',
                cycle: sub.cycle,
                agenda: sub.agenda,
                stock: sub.stock,
                status: sub.cancelAtPeriodEnd && sub.status === 'ACTIVE' ? 'CANCELLED' : sub.status,
                access: sub.access,
                currentPeriodStart: iso(sub.endsInDays - 30),
                currentPeriodEnd: iso(sub.endsInDays),
                graceEndsAt: iso(sub.endsInDays + 5),
                trialEndsAt: sub.status === 'TRIAL' ? iso(sub.endsInDays) : null,
                cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
                pendingChange: sub.pendingChange,
                maxCompanies: PLANS.find((item) => item.code === sub.planCode)?.maxCompanies ?? 1,
                companies: sub.companies,
                whatsappBillingMode: 'CUSTOMER_PAYS_META',
                whatsappNotice: 'NOT_INCLUDED',
              },
        usage:
          sub === null
            ? null
            : {
                windowStart: iso(-10),
                windowEnd: iso(20),
                tokens: { used: state.usage.tokens[0], limit: state.usage.tokens[1] },
                replies: { used: state.usage.replies[0], limit: state.usage.replies[1] },
                metaEstimate: { isEstimate: true, milliCents: state.usage.milliCents },
              },
        orders: state.orders,
        catalog: PLANS.map((plan) => ({
          code: plan.code,
          name: plan.name,
          maxCompanies: plan.maxCompanies,
          monthlyTokens: plan.replies * 6_000,
          monthlyReplies: plan.replies,
          metaEstimateMilliCents: 3_500,
          prices: (['MONTHLY', 'ANNUAL'] as const).map((cycle) => ({
            cycle,
            baseCents: plan.base[index(cycle)],
            agendaCents: plan.agenda[index(cycle)],
            stockCents: plan.stock[index(cycle)],
            whatsappBillingMode: 'CUSTOMER_PAYS_META',
            perReplyMilliCents: (state.perReply?.[plan.code] ?? plan.perReply)[index(cycle)],
          })),
        })),
        trial: { available: sub === null, days: 7 },
        checkoutEnabled: state.checkoutEnabled,
        checkoutHost: state.checkoutEnabled ? 'checkout.exemplo.test' : null,
      });
    }
    if (!state.checkoutEnabled) return fail(404, 'NOT_FOUND');
    if (sub === null) return fail(409, 'NO_SUBSCRIPTION');

    const current = {
      planCode: sub.planCode,
      cycle: sub.cycle,
      agenda: sub.agenda,
      stock: sub.stock,
    };
    if (path === '/account/billing/quote') {
      if (state.quoteError !== null) return fail(state.quoteError.status, state.quoteError.code);
      const q = url.searchParams;
      const selection = {
        planCode: q.get('planCode') as keyof typeof RANK,
        cycle: q.get('cycle') as 'MONTHLY' | 'ANNUAL',
        agenda: q.get('agenda') === 'true',
        stock: q.get('stock') === 'true',
      };
      const paidInForce = sub.status !== 'TRIAL' && sub.access !== 'blocked';
      if (!paidInForce) {
        return reply(200, {
          kind: 'NEW',
          amountCents: total(selection),
          effective: 'now',
          periodEnd: null,
          remainingDays: null,
        });
      }
      const same =
        selection.planCode === current.planCode &&
        selection.cycle === current.cycle &&
        selection.agenda === current.agenda &&
        selection.stock === current.stock;
      if (same) {
        return reply(200, {
          kind: 'RENEWAL',
          amountCents: total(selection),
          effective: 'now',
          periodEnd: iso(sub.endsInDays),
          remainingDays: null,
        });
      }
      const up =
        selection.cycle === current.cycle &&
        RANK[selection.planCode] >= RANK[current.planCode] &&
        (!current.agenda || selection.agenda) &&
        (!current.stock || selection.stock);
      if (up) {
        return reply(200, {
          kind: 'UPGRADE',
          amountCents: 4321,
          effective: 'now',
          periodEnd: iso(sub.endsInDays),
          remainingDays: sub.endsInDays,
        });
      }
      return reply(200, {
        kind: selection.cycle === current.cycle ? 'DOWNGRADE' : 'CYCLE_CHANGE',
        amountCents: 0,
        effective: 'next_renewal',
        periodEnd: iso(sub.endsInDays),
        remainingDays: null,
      });
    }

    const makeOrder = (kind: FakeOrder['kind'], amountCents: number) => {
      const id = randomUUID();
      state.orders.unshift({
        id,
        kind,
        status: 'PENDING',
        amountCents,
        createdAt: new Date().toISOString(),
        paidAt: null,
      });
      state.created.push(id);
      return {
        orderId: id,
        checkoutUrl: `${CHECKOUT_HOST}/pay/${id}`,
        amountCents,
        expiresAt: iso(1),
      };
    };

    if (path === '/account/billing/orders' && method === 'POST') {
      const selection = body as Parameters<typeof total>[0];
      const kind = sub.status === 'TRIAL' || sub.access === 'blocked' ? 'NEW' : 'RENEWAL';
      return reply(201, makeOrder(kind, total(selection)));
    }
    if (path === '/account/billing/plan-change' && method === 'POST') {
      const action = (body as { action: string }).action;
      if (action === 'upgrade') return reply(201, makeOrder('UPGRADE', 4321));
      if (action === 'downgrade') {
        const { planCode, cycle, agenda, stock } = body as NonNullable<
          FakeSubscription['pendingChange']
        >;
        sub.pendingChange = { planCode, cycle, agenda, stock };
      } else if (action === 'undo_pending') {
        sub.pendingChange = null;
      } else if (action === 'cancel') {
        sub.cancelAtPeriodEnd = true;
      } else if (action === 'reactivate') {
        sub.cancelAtPeriodEnd = false;
      }
      return reply(200, {
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        pendingChange: sub.pendingChange,
      });
    }
    const check = /^\/account\/billing\/orders\/([^/]+)\/check$/.exec(path);
    if (check !== null && method === 'POST') {
      const order = state.orders.find((item) => item.id === check[1]);
      if (order === undefined) return fail(404, 'NOT_FOUND');
      const outcome =
        state.checks.length > 1
          ? (state.checks.shift() ?? 'pending')
          : (state.checks[0] ?? 'pending');
      if (outcome === 'paid') {
        order.status = 'PAID';
        order.paidAt = new Date().toISOString();
        sub.status = 'ACTIVE';
        sub.access = 'ok';
        sub.endsInDays = 30;
      } else if (outcome === 'failed') {
        order.status = 'FAILED';
      }
      return reply(200, { outcome, order });
    }
    return fail(404, 'NOT_FOUND');
  });
}
