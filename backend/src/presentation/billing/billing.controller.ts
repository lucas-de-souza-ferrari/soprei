import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import type { AccountService } from '../../application/auth/account.service.js';
import type { BillingOverview, BillingService } from '../../application/billing/billing.service.js';
import type {
  CheckoutService,
  OrderCheckResult,
} from '../../application/billing/checkout.service.js';
import { BILLING_CYCLES, PLAN_CODES } from '../../domain/index.js';
import { ForbiddenError } from '../../shared/errors/index.js';
import { accountCookie } from '../auth/account.controller.js';
import { rateLimitProfile } from '../common/rate-limit.js';

export interface BillingControllerOptions {
  readonly service: Pick<BillingService, 'overview'>;
  readonly accounts: Pick<AccountService, 'me'>;
  readonly origin: string;
  /** Host do link de pagamento (só o nome, sem esquema): o site só abre links deste host. */
  readonly checkoutHost?: string | undefined;
  /** Checkout (E3): só com CHECKOUT_ENABLED; sem ele as rotas de pedido não existem (404). */
  readonly checkout?:
    | Pick<
        CheckoutService,
        | 'createOrder'
        | 'checkOrder'
        | 'quote'
        | 'upgrade'
        | 'scheduleChange'
        | 'undoPendingChange'
        | 'cancel'
        | 'reactivate'
        | 'changeState'
      >
    | undefined;
}

/** Corpo de POST /account/billing/orders: só a escolha. Valor, desconto e período são do servidor (strict recusa o resto). */
export const createOrderBodySchema = z
  .object({
    planCode: z.enum(PLAN_CODES),
    cycle: z.enum(BILLING_CYCLES),
    agenda: z.boolean(),
    stock: z.boolean(),
  })
  .strict();

/** Escolha de plano: só a escolha; preço, desconto e período são do servidor (strict recusa o resto). */
const selectionFields = {
  planCode: z.enum(PLAN_CODES),
  agenda: z.boolean(),
  stock: z.boolean(),
};

/**
 * POST /account/billing/plan-change (spec 031, D11). upgrade: pedido proporcional no mesmo ciclo;
 * downgrade: troca AGENDADA para a próxima renovação (plano menor, módulo a menos ou outro ciclo);
 * cancel, reactivate e undo_pending não levam mais nada.
 */
export const planChangeBodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('upgrade'), ...selectionFields }).strict(),
  z
    .object({
      action: z.literal('downgrade'),
      ...selectionFields,
      cycle: z.enum(BILLING_CYCLES).optional(),
    })
    .strict(),
  z.object({ action: z.literal('cancel') }).strict(),
  z.object({ action: z.literal('reactivate') }).strict(),
  z.object({ action: z.literal('undo_pending') }).strict(),
]);

const booleanText = z.enum(['true', 'false']).transform((value) => value === 'true');
/** Query de GET /account/billing/quote. */
export const quoteQuerySchema = z
  .object({
    planCode: z.enum(PLAN_CODES),
    cycle: z.enum(BILLING_CYCLES).optional(),
    agenda: booleanText,
    stock: booleanText,
  })
  .strict();

const REFERENCE = /^[A-Za-z0-9._:-]{1,128}$/;
/** Corpo de .../check: as referências do retorno do checkout são opcionais e só viram parâmetro da consulta. */
export const checkOrderBodySchema = z
  .object({
    transactionNsu: z.string().regex(REFERENCE).optional(),
    slug: z.string().regex(REFERENCE).optional(),
  })
  .strict();

/** O que o site pode saber do resultado da confirmação (sem expor erro de configuração do provedor). */
function toCheckResponse({ order, result }: OrderCheckResult): object {
  const outcome =
    order.status === 'PAID'
      ? 'paid'
      : order.status === 'FAILED'
        ? 'failed'
        : result === 'unavailable' || result === 'config_error' || result === 'unverifiable'
          ? 'unavailable'
          : 'pending';
  return {
    outcome,
    order: {
      id: order.id,
      kind: order.kind,
      status: order.status,
      amountCents: order.amountCents,
      createdAt: order.createdAt.toISOString(),
      paidAt: order.paidAt?.toISOString() ?? null,
    },
  };
}

/** Corpo de `GET /account/billing`: datas em ISO UTC e dinheiro em centavos; nenhum dado de outra conta. */
export function toBillingResponse(
  overview: BillingOverview,
  checkoutEnabled = false,
  checkoutHost: string | null = null,
): object {
  const { subscription, usage } = overview;
  return {
    subscription:
      subscription === null
        ? null
        : {
            ...subscription,
            currentPeriodStart: subscription.currentPeriodStart.toISOString(),
            currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
            graceEndsAt: subscription.graceEndsAt.toISOString(),
            trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null,
          },
    usage:
      usage === null
        ? null
        : {
            ...usage,
            windowStart: usage.windowStart.toISOString(),
            windowEnd: usage.windowEnd.toISOString(),
          },
    orders: overview.orders.map((order) => ({
      id: order.id,
      kind: order.kind,
      status: order.status,
      amountCents: order.amountCents,
      createdAt: order.createdAt.toISOString(),
      paidAt: order.paidAt?.toISOString() ?? null,
    })),
    catalog: overview.catalog.map((entry) => ({
      code: entry.plan.code,
      name: entry.plan.name,
      maxCompanies: entry.plan.maxCompanies,
      monthlyTokens: entry.plan.monthlyTokens,
      monthlyReplies: entry.plan.monthlyReplies,
      metaEstimateMilliCents: entry.plan.metaEstimateMilliCents,
      prices: entry.prices.map((price) => ({
        cycle: price.cycle,
        baseCents: price.baseCents,
        agendaCents: price.agendaCents,
        stockCents: price.stockCents,
        whatsappBillingMode: price.whatsappBillingMode,
        extraPackCents: price.extraPackCents,
        extraPackReplies: price.extraPackReplies,
      })),
    })),
    trial: overview.trial,
    // Sem checkout (CHECKOUT_ENABLED desligado) a tela mostra o plano mas não oferece pagar nem trocar.
    checkoutEnabled,
    checkoutHost: checkoutEnabled ? checkoutHost : null,
  };
}

/**
 * Cobrança da conta (spec 031). **Só existe com `BILLING_ENABLED=true`** (sem isto as rotas dão 404).
 * A assinatura é da CONTA: o id vem só do cookie da sessão (nunca de caminho, query ou corpo) e nenhuma
 * permissão de papel é usada. Quem entrou por convite e não tem empresa própria não tem assinatura:
 * recebe `subscription: null`.
 */
export const billingController: FastifyPluginCallback<BillingControllerOptions> = (
  app,
  { service, accounts, origin, checkout, checkoutHost },
  done,
) => {
  app.addHook('onRequest', (request, reply, next) => {
    void reply.header('cache-control', 'no-store');
    if (
      !['GET', 'HEAD'].includes(request.method) &&
      (request.headers.origin !== origin || request.headers['x-soprei-app'] !== 'web')
    ) {
      next(new ForbiddenError('Origem inválida'));
      return;
    }
    next();
  });
  const config = rateLimitProfile('admin');
  app.get('/account/billing', { config }, async (request) => {
    const account = await accounts.me(accountCookie(request.headers.cookie));
    return toBillingResponse(
      await service.overview(account.id),
      checkout !== undefined,
      checkoutHost ?? null,
    );
  });

  if (checkout !== undefined) {
    // A conta vem só do cookie; o pedido pertence a ela (pedido de outra conta é o mesmo 404).
    app.post('/account/billing/orders', { config }, async (request, reply) => {
      const account = await accounts.me(accountCookie(request.headers.cookie));
      const body = createOrderBodySchema.parse(request.body);
      const created = await checkout.createOrder({ id: account.id, email: account.email }, body);
      return reply.code(201).send({
        orderId: created.orderId,
        checkoutUrl: created.checkoutUrl,
        amountCents: created.amountCents,
        expiresAt: created.expiresAt.toISOString(),
      });
    });
    // Cotação da troca: o valor proporcional é calculado no servidor, sem criar pedido.
    app.get('/account/billing/quote', { config }, async (request) => {
      const account = await accounts.me(accountCookie(request.headers.cookie));
      const query = quoteQuerySchema.parse(request.query);
      const quote = await checkout.quote(account.id, query);
      return {
        kind: quote.kind,
        amountCents: quote.amountCents,
        effective: quote.effective,
        periodEnd: quote.periodEnd?.toISOString() ?? null,
        remainingDays: quote.remainingDays,
      };
    });
    app.post('/account/billing/plan-change', { config }, async (request, reply) => {
      const account = await accounts.me(accountCookie(request.headers.cookie));
      const body = planChangeBodySchema.parse(request.body);
      if (body.action === 'upgrade') {
        // O ciclo do upgrade é sempre o da assinatura atual (o serviço o resolve).
        const created = await checkout.upgrade(
          { id: account.id, email: account.email },
          { planCode: body.planCode, agenda: body.agenda, stock: body.stock },
        );
        return reply.code(201).send({
          orderId: created.orderId,
          checkoutUrl: created.checkoutUrl,
          amountCents: created.amountCents,
          expiresAt: created.expiresAt.toISOString(),
        });
      }
      if (body.action === 'downgrade') {
        await checkout.scheduleChange(account.id, body);
      } else if (body.action === 'cancel') {
        await checkout.cancel(account.id);
      } else if (body.action === 'reactivate') {
        await checkout.reactivate(account.id);
      } else {
        await checkout.undoPendingChange(account.id);
      }
      const state = await checkout.changeState(account.id);
      return { cancelAtPeriodEnd: state.cancelAtPeriodEnd, pendingChange: state.pendingChange };
    });
    app.post<{ Params: { orderId: string } }>(
      '/account/billing/orders/:orderId/check',
      { config },
      async (request) => {
        const account = await accounts.me(accountCookie(request.headers.cookie));
        const body = checkOrderBodySchema.parse(request.body ?? {});
        return toCheckResponse(await checkout.checkOrder(account.id, request.params.orderId, body));
      },
    );
  }
  done();
};
