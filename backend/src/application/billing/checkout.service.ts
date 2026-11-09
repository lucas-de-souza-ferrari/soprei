import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import {
  type BillingCycle,
  type BillingRepository,
  CHECKOUT_MIN_AMOUNT_CENTS,
  type CheckoutRepository,
  type OrderBreakdown,
  ORDER_MAX_PER_DAY,
  ORDER_VALIDITY_MS,
  type PaymentOrderKindValue,
  type PaymentOrderRecord,
  type PlanCode,
  priceTotalCents,
  resolveAccess,
} from '../../domain/index.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import {
  BaseError,
  ConflictError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from '../../shared/errors/index.js';
import { isUuid } from '../../shared/utils/index.js';
import type { PaymentProvider } from '../ports/payment-provider.js';
import type { PaymentHints, PaymentVerifier, VerifyResult } from './payment-verifier.js';

export interface CheckoutSettings {
  readonly graceDays: number;
  /** APP_ORIGIN: origem do site, sem barra final (a volta do checkout). */
  readonly appOrigin: string;
  /** Origem pública do backend para a webhook_url (INFINITEPAY_WEBHOOK_BASE_URL), sem barra final. */
  readonly webhookBaseUrl: string;
  /** SOPREI_PAYS_META_ENABLED: sem ele o modo S não é vendido. */
  readonly allowSopreiPaysMeta: boolean;
}

/** O que o navegador manda para criar um pedido: só a escolha. Preço, desconto e período são do servidor. */
export interface OrderRequest {
  readonly planCode: PlanCode;
  readonly cycle: BillingCycle;
  readonly agenda: boolean;
  readonly stock: boolean;
}

export interface CreatedOrder {
  readonly orderId: string;
  readonly checkoutUrl: string;
  readonly amountCents: number;
  readonly expiresAt: Date;
}

/** Corpo do evento do webhook já reduzido ao mínimo (só ids curtos validados). */
export interface WebhookEvent {
  readonly orderNsu: string | undefined;
  readonly transactionNsu: string | undefined;
  readonly invoiceSlug: string | undefined;
}

export type WebhookOutcome = 'recorded' | 'duplicate' | 'unknown_order';

/** Resultado de "Já paguei": a situação do pedido depois da confirmação e o que a confirmação disse. */
export interface OrderCheckResult {
  readonly order: PaymentOrderRecord;
  readonly result: VerifyResult;
}

const PLAN_DESCRIPTION: Readonly<Record<PlanCode, string>> = {
  ESSENTIAL: 'Essencial',
  PROFESSIONAL: 'Profissional',
  SCALE: 'Escala',
};

/**
 * Checkout da assinatura (spec 031, E3): cria o pedido e o link de pagamento da InfinitePay, recebe o
 * webhook e atende o "Já paguei". O valor SEMPRE sai do catálogo no servidor; o pedido pertence à conta (o
 * AccountId vem só do cookie); a concessão é do PaymentVerifier.
 */
export class CheckoutService {
  constructor(
    private readonly deps: {
      readonly billing: Pick<BillingRepository, 'findSubscription' | 'catalog' | 'countCompanies'>;
      readonly checkout: CheckoutRepository;
      readonly provider: PaymentProvider;
      readonly verifier: Pick<PaymentVerifier, 'verify' | 'verifyInBackground'>;
      readonly settings: CheckoutSettings;
      readonly logger: FastifyBaseLogger;
      readonly metrics?: Pick<Metrics, 'countBillingOrder' | 'countBillingWebhook'> | undefined;
      readonly now?: (() => Date) | undefined;
    },
  ) {}

  async createOrder(
    account: { readonly id: string; readonly email: string },
    request: OrderRequest,
  ): Promise<CreatedOrder> {
    const { billing, checkout, provider, settings, logger, metrics } = this.deps;
    const now = this.deps.now?.() ?? new Date();
    const subscription = await billing.findSubscription(account.id);
    if (subscription === null) {
      throw new ConflictError('Crie uma empresa antes de assinar um plano', {
        code: 'NO_SUBSCRIPTION',
      });
    }
    const catalog = await billing.catalog(now, settings.allowSopreiPaysMeta);
    const entry = catalog.find((candidate) => candidate.plan.code === request.planCode);
    const price = entry?.prices.find((candidate) => candidate.cycle === request.cycle);
    if (entry === undefined || price === undefined) {
      throw new ValidationError('Plano indisponível', { context: { reason: 'plan_unavailable' } });
    }

    // Quem tem mais empresas que o plano escolhido comporta não pode assinar esse plano (nada é apagado).
    if ((await billing.countCompanies(account.id)) > entry.plan.maxCompanies) {
      throw new ConflictError('Você tem mais empresas do que este plano comporta', {
        code: 'PLAN_DOWNGRADE_BLOCKED',
      });
    }

    const amountCents = priceTotalCents(price, request);
    if (amountCents < CHECKOUT_MIN_AMOUNT_CENTS) {
      throw new ValidationError('Valor do plano inválido', { context: { reason: 'amount_low' } });
    }

    // Assinatura paga e em vigor (ou na carência): só a renovação do mesmo plano, ciclo e módulos. Trocar
    // de plano no meio do ciclo (upgrade e downgrade, D11) é da etapa E4.
    const access = resolveAccess(subscription, now, settings.graceDays).access;
    const paidAndInForce = subscription.status !== 'TRIAL' && access !== 'blocked';
    let kind: PaymentOrderKindValue = 'NEW';
    if (paidAndInForce) {
      const same =
        subscription.plan.code === request.planCode &&
        subscription.cycle === request.cycle &&
        subscription.agendaEnabled === request.agenda &&
        subscription.stockEnabled === request.stock;
      if (!same) {
        metrics?.countBillingOrder('UPGRADE', 'rejected');
        throw new ConflictError('A troca de plano durante o ciclo ainda não está disponível', {
          code: 'PLAN_CHANGE_UNAVAILABLE',
        });
      }
      kind = 'RENEWAL';
    }

    const since = new Date(now.getTime() - ORDER_VALIDITY_MS);
    if ((await checkout.countOrdersSince(account.id, since)) >= ORDER_MAX_PER_DAY) {
      metrics?.countBillingOrder(kind, 'limit');
      throw new RateLimitError(3_600, 'Muitos pedidos hoje. Tente novamente mais tarde.', {
        code: 'ORDER_LIMIT_REACHED',
      });
    }

    const breakdown: OrderBreakdown = {
      planCode: request.planCode,
      cycle: request.cycle,
      agenda: request.agenda,
      stock: request.stock,
      priceId: price.id,
      priceVersion: price.version,
      whatsappBillingMode: price.whatsappBillingMode,
    };
    const orderId = randomUUID();
    const expiresAt = new Date(now.getTime() + ORDER_VALIDITY_MS);
    // O pedido é gravado ANTES de chamar o provedor: o webhook sempre acha a linha.
    const order = await checkout.createPendingOrder(account.id, {
      id: orderId,
      kind,
      amountCents,
      breakdown,
      expiresAt,
    });
    if (order === null) {
      throw new ConflictError('Crie uma empresa antes de assinar um plano', {
        code: 'NO_SUBSCRIPTION',
      });
    }

    const link = await provider.createLink({
      orderId,
      amountCents,
      description: describe(entry.plan.code, request),
      customerEmail: account.email,
      redirectUrl: `${settings.appOrigin}/painel/assinatura`,
      webhookUrl: `${settings.webhookBaseUrl}/webhooks/infinitepay/${orderId}`,
      validUntil: expiresAt,
    });
    if (!link.ok) {
      // Nada fica pendente pendurado: o pedido sem link é apagado.
      await checkout.discardUnlinkedOrder(orderId);
      const reason = link.error.reason;
      metrics?.countBillingOrder(kind, reason === 'config' ? 'provider_config' : 'link_failed');
      if (reason === 'config') {
        logger.error(
          { accountId: account.id, orderId },
          'provedor de pagamento recusou a credencial ao criar o link; confira INFINITEPAY_API_KEY e INFINITEPAY_HANDLE',
        );
      } else {
        logger.warn({ accountId: account.id, orderId, reason }, 'não foi possível criar o link');
      }
      throw new BaseError({
        message: 'Não foi possível gerar o link de pagamento agora. Tente novamente em instantes.',
        code: 'CHECKOUT_UNAVAILABLE',
        statusCode: 502,
      });
    }
    await checkout.attachCheckoutUrl(orderId, link.value.url);
    await checkout.expireSiblings(order.subscriptionId, kind, orderId);
    metrics?.countBillingOrder(kind, 'created');
    logger.info({ accountId: account.id, orderId, kind }, 'pedido de pagamento criado');
    return { orderId, checkoutUrl: link.value.url, amountCents, expiresAt };
  }

  /**
   * "Já paguei" e o retorno do checkout: refazem a consulta de status. Só o dono do pedido (a conta do
   * cookie); pedido de outra conta é o mesmo 404. A query do retorno vira só parâmetro da consulta.
   */
  async checkOrder(
    accountId: string,
    orderId: string,
    hints: PaymentHints = {},
  ): Promise<OrderCheckResult> {
    const { checkout, verifier } = this.deps;
    const order = isUuid(orderId) ? await checkout.findOrder(accountId, orderId) : null;
    if (order === null) throw new NotFoundError('Pedido não encontrado');
    const result = await verifier.verify(order.id, hints);
    const fresh = (await checkout.findOrder(accountId, orderId)) ?? order;
    return { order: fresh, result };
  }

  /**
   * Webhook: NÃO confia no corpo. Grava só a referência (idempotente) e dispara a confirmação em segundo
   * plano. Falha ao gravar propaga (o controller responde 400 para a InfinitePay tentar de novo).
   * order_nsu desconhecido ou diferente do da rota: nada acontece e nada vaza.
   */
  async acceptWebhook(orderId: string, event: WebhookEvent): Promise<WebhookOutcome> {
    const { checkout, verifier, metrics } = this.deps;
    const count = (result: 'recorded' | 'duplicate' | 'unknown_order'): WebhookOutcome => {
      metrics?.countBillingWebhook(result);
      return result;
    };
    if (!isUuid(orderId)) return count('unknown_order');
    if (event.orderNsu !== undefined && event.orderNsu !== orderId) return count('unknown_order');
    const order = await checkout.findOrderById(orderId);
    if (order === null) return count('unknown_order');
    if (order.status === 'PAID' || order.status === 'FAILED') return count('duplicate');
    if (event.transactionNsu !== undefined) {
      await checkout.recordWebhookEvent(orderId, {
        transactionNsu: event.transactionNsu,
        slug: event.invoiceSlug ?? null,
      });
    }
    verifier.verifyInBackground(orderId, {
      transactionNsu: event.transactionNsu,
      slug: event.invoiceSlug,
    });
    return count('recorded');
  }
}

function describe(code: PlanCode, request: OrderRequest): string {
  const modules = [request.agenda ? 'Agenda' : null, request.stock ? 'Estoque' : null].filter(
    (value) => value !== null,
  );
  const cycle = request.cycle === 'ANNUAL' ? 'anual' : 'mensal';
  return `Soprei ${PLAN_DESCRIPTION[code]} ${cycle}${modules.length > 0 ? ` + ${modules.join(' e ')}` : ''}`;
}
