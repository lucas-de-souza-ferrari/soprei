import type { FastifyPluginCallback } from 'fastify';
import type { AccountService } from '../../application/auth/account.service.js';
import type { BillingOverview, BillingService } from '../../application/billing/billing.service.js';
import { ForbiddenError } from '../../shared/errors/index.js';
import { accountCookie } from '../auth/account.controller.js';
import { rateLimitProfile } from '../common/rate-limit.js';

export interface BillingControllerOptions {
  readonly service: Pick<BillingService, 'overview'>;
  readonly accounts: Pick<AccountService, 'me'>;
  readonly origin: string;
}

/** Corpo de `GET /account/billing`: datas em ISO UTC e dinheiro em centavos; nenhum dado de outra conta. */
export function toBillingResponse(overview: BillingOverview): object {
  const { subscription, usage } = overview;
  return {
    subscription:
      subscription === null
        ? null
        : {
            ...subscription,
            currentPeriodStart: subscription.currentPeriodStart.toISOString(),
            currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
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
  { service, accounts, origin },
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
    return toBillingResponse(await service.overview(account.id));
  });
  done();
};
