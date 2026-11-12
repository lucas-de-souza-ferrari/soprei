import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import {
  type AccessLevel,
  type BillingCycle,
  type BillingRepository,
  type CatalogEntry,
  CHECKOUT_MIN_AMOUNT_CENTS,
  type ChangeRelation,
  type CheckoutRepository,
  classifyChange,
  type PendingChange,
  type PlanPriceRecord,
  type PlanSelection,
  prorateUpgradeCents,
  samePlanSelection,
  type SubscriptionRecord,
  type UpgradeBase,
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
import { isUuid, messageRef } from '../../shared/utils/index.js';
import { verifyWebhookToken, webhookToken } from './webhook-token.js';
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
  /** Chave derivada do JWT_SECRET para o token da webhook_url (deriveWebhookSecret). */
  readonly webhookSecret: Buffer;
  /** CHECKOUT_SEND_CUSTOMER_EMAIL: o e-mail da conta só vai ao provedor se o dono confirmar (LGPD). */
  readonly sendCustomerEmail: boolean;
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

/** Escolha de uma troca: sem ciclo vale o da assinatura atual. */
export interface ChangeRequest {
  readonly planCode: PlanCode;
  readonly cycle?: BillingCycle | undefined;
  readonly agenda: boolean;
  readonly stock: boolean;
}

/** Cotação de uma troca (só do servidor): valor em centavos e quando vale. */
export interface ChangeQuote {
  readonly kind: 'NEW' | 'RENEWAL' | 'UPGRADE' | 'DOWNGRADE' | 'CYCLE_CHANGE';
  /** NEW e RENEWAL: o valor cheio do ciclo; UPGRADE: o proporcional; DOWNGRADE: 0 (agendada, sem cobrança). */
  readonly amountCents: number;
  readonly effective: 'now' | 'next_renewal';
  readonly periodEnd: Date | null;
  readonly remainingDays: number | null;
}

/** Corpo do evento do webhook já reduzido ao mínimo (só ids curtos validados). */
export interface WebhookEvent {
  readonly orderNsu: string | undefined;
  readonly transactionNsu: string | undefined;
  readonly invoiceSlug: string | undefined;
}

export type WebhookOutcome = 'recorded' | 'duplicate' | 'unknown_order' | 'bad_token' | 'throttled';

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
      readonly billing: Pick<
        BillingRepository,
        'findSubscription' | 'catalog' | 'countCompaniesIncludingUnadopted'
      >;
      readonly checkout: CheckoutRepository;
      readonly provider: PaymentProvider;
      readonly verifier: Pick<PaymentVerifier, 'verify' | 'verifyInBackground'>;
      readonly settings: CheckoutSettings;
      readonly logger: FastifyBaseLogger;
      readonly metrics?: Pick<Metrics, 'countBillingOrder' | 'countBillingWebhook'> | undefined;
      readonly now?: (() => Date) | undefined;
    },
  ) {}

  /** Contexto comum de uma escolha: assinatura atual, plano e preço do catálogo e a relação com o que há. */
  private async evaluate(
    accountId: string,
    input: ChangeRequest,
    now: Date,
  ): Promise<{
    readonly target: OrderRequest;
    readonly subscription: SubscriptionRecord;
    readonly entry: CatalogEntry;
    readonly price: PlanPriceRecord;
    readonly paidAndInForce: boolean;
    readonly access: AccessLevel;
    readonly current: PlanSelection;
    readonly relation: ChangeRelation;
  }> {
    const { billing, settings } = this.deps;
    const subscription = await billing.findSubscription(accountId);
    if (subscription === null) {
      throw new ConflictError('Crie uma empresa antes de assinar um plano', {
        code: 'NO_SUBSCRIPTION',
      });
    }
    const request: OrderRequest = {
      planCode: input.planCode,
      cycle: input.cycle ?? subscription.cycle,
      agenda: input.agenda,
      stock: input.stock,
    };
    const catalog = await billing.catalog(now, settings.allowSopreiPaysMeta);
    const entry = catalog.find((candidate) => candidate.plan.code === request.planCode);
    const price = entry?.prices.find((candidate) => candidate.cycle === request.cycle);
    if (entry === undefined || price === undefined) {
      throw new ValidationError('Plano indisponível', { context: { reason: 'plan_unavailable' } });
    }
    const access = resolveAccess(subscription, now, settings.graceDays).access;
    const current: PlanSelection = {
      planCode: subscription.plan.code,
      cycle: subscription.cycle,
      agenda: subscription.agendaEnabled,
      stock: subscription.stockEnabled,
    };
    return {
      target: request,
      subscription,
      entry,
      price,
      access,
      paidAndInForce: subscription.status !== 'TRIAL' && access !== 'blocked',
      current,
      relation: classifyChange(current, request),
    };
  }

  /** Quem tem mais empresas (inclusive não adotadas) que o plano comporta não pode ir para ele. */
  private async assertFits(accountId: string, entry: CatalogEntry): Promise<void> {
    if (
      (await this.deps.billing.countCompaniesIncludingUnadopted(accountId)) >
      entry.plan.maxCompanies
    ) {
      throw new ConflictError('Você tem mais empresas do que este plano comporta', {
        code: 'PLAN_DOWNGRADE_BLOCKED',
      });
    }
  }

  async createOrder(
    account: { readonly id: string; readonly email: string },
    request: OrderRequest,
  ): Promise<CreatedOrder> {
    const { metrics } = this.deps;
    const now = this.deps.now?.() ?? new Date();
    const ev = await this.evaluate(account.id, request, now);
    await this.assertFits(account.id, ev.entry);

    const amountCents = priceTotalCents(ev.price, request);
    if (amountCents < CHECKOUT_MIN_AMOUNT_CENTS) {
      throw new ValidationError('Valor do plano inválido', { context: { reason: 'amount_low' } });
    }

    // Assinatura paga e em vigor (ou na carência): só a renovação. Sem troca agendada, o mesmo plano, ciclo
    // e módulos; com troca agendada, o pedido é o da troca (o preço é o do plano pendente). Trocar no meio do
    // ciclo é pelas rotas de troca (upgrade proporcional ou troca agendada).
    let kind: PaymentOrderKindValue = 'NEW';
    if (ev.paidAndInForce) {
      const pending = ev.subscription.pendingChange;
      if (pending !== null) {
        if (samePlanSelection(request, pending)) kind = 'RENEWAL';
        else if (samePlanSelection(request, ev.current)) {
          throw new ConflictError('Há uma troca agendada; desfaça-a para renovar o plano atual', {
            code: 'PENDING_CHANGE_EXISTS',
          });
        } else {
          metrics?.countBillingOrder('RENEWAL', 'rejected');
          throw new ConflictError('Use a troca de plano para mudar de plano durante o ciclo', {
            code: 'USE_PLAN_CHANGE',
          });
        }
      } else if (ev.relation === 'same') {
        kind = 'RENEWAL';
      } else {
        metrics?.countBillingOrder('RENEWAL', 'rejected');
        throw new ConflictError('Use a troca de plano para mudar de plano durante o ciclo', {
          code: 'USE_PLAN_CHANGE',
        });
      }
    }
    return this.issueOrder(account, ev.entry, ev.price, request, kind, amountCents, now);
  }

  /**
   * Cotação da troca, calculada só no servidor e sem criar pedido: o valor proporcional do upgrade, ou a troca
   * agendada para a renovação. Mesmas recusas da troca de verdade. Dinheiro em centavos.
   */
  async quote(accountId: string, input: ChangeRequest): Promise<ChangeQuote> {
    const now = this.deps.now?.() ?? new Date();
    const ev = await this.evaluate(accountId, input, now);
    const request = ev.target;
    if (!ev.paidAndInForce) {
      return {
        kind: 'NEW',
        amountCents: priceTotalCents(ev.price, request),
        effective: 'now',
        periodEnd: null,
        remainingDays: null,
      };
    }
    const periodEnd = ev.subscription.currentPeriodEnd;
    if (ev.relation === 'same') {
      return {
        kind: 'RENEWAL',
        amountCents: priceTotalCents(ev.price, request),
        effective: 'now',
        periodEnd,
        remainingDays: null,
      };
    }
    if (ev.relation === 'up') {
      const plan = this.upgradePlan(ev, request, now);
      return {
        kind: 'UPGRADE',
        amountCents: plan.cents,
        effective: 'now',
        periodEnd,
        remainingDays: Math.floor(plan.remainingMs / 86_400_000),
      };
    }
    await this.assertFits(accountId, ev.entry);
    return {
      kind: ev.relation === 'cycle' ? 'CYCLE_CHANGE' : 'DOWNGRADE',
      amountCents: 0,
      effective: 'next_renewal',
      periodEnd,
      remainingDays: null,
    };
  }

  /** Valida e calcula o upgrade (mesma lógica da cotação e do pedido). */
  private upgradePlan(
    ev: Awaited<ReturnType<CheckoutService['evaluate']>>,
    request: OrderRequest,
    now: Date,
  ): { readonly cents: number; readonly remainingMs: number } {
    const sub = ev.subscription;
    if (!ev.paidAndInForce || ev.access !== 'ok' || sub.status !== 'ACTIVE') {
      throw new ConflictError('Não há plano pago em vigor para trocar; renove ou assine', {
        code: 'PLAN_CHANGE_UNAVAILABLE',
      });
    }
    if (sub.cancelAtPeriodEnd) {
      throw new ConflictError('A assinatura está cancelada para o fim do período; reative antes', {
        code: 'PLAN_CHANGE_UNAVAILABLE',
      });
    }
    if (sub.pendingChange !== null) {
      throw new ConflictError('Há uma troca agendada; desfaça-a antes de fazer um upgrade', {
        code: 'PENDING_CHANGE_EXISTS',
      });
    }
    if (ev.relation !== 'up') {
      throw new ConflictError('A escolha não é um upgrade', { code: 'NOT_AN_UPGRADE' });
    }
    const result = prorateUpgradeCents({
      currentTotalCents: priceTotalCents(sub.price, {
        agenda: sub.agendaEnabled,
        stock: sub.stockEnabled,
      }),
      newTotalCents: priceTotalCents(ev.price, request),
      cycle: sub.cycle,
      periodStart: sub.currentPeriodStart,
      periodEnd: sub.currentPeriodEnd,
      now,
    });
    if (!result.ok) {
      throw new ConflictError(
        result.reason === 'too_late'
          ? 'Falta menos de um dia para o fim do período; renove e troque na renovação'
          : 'Não foi possível calcular o upgrade',
        { code: result.reason === 'too_late' ? 'UPGRADE_TOO_LATE' : 'PLAN_CHANGE_UNAVAILABLE' },
      );
    }
    return { cents: result.cents, remainingMs: result.remainingMs };
  }

  /**
   * Upgrade no meio do ciclo pago: pedido UPGRADE com a diferença proporcional (só do catálogo e do período
   * gravado), no mesmo ciclo; vale na hora ao pagar e NÃO muda o fim do período. Só um UPGRADE aberto por
   * assinatura (o novo substitui o anterior).
   */
  async upgrade(
    account: { readonly id: string; readonly email: string },
    input: ChangeRequest,
  ): Promise<CreatedOrder> {
    const now = this.deps.now?.() ?? new Date();
    const ev = await this.evaluate(account.id, input, now);
    const request = ev.target;
    if (ev.current.cycle !== request.cycle) {
      throw new ConflictError('O ciclo só muda na renovação', { code: 'CYCLE_CHANGE_ON_RENEWAL' });
    }
    const plan = this.upgradePlan(ev, request, now);
    await this.assertFits(account.id, ev.entry);
    const sub = ev.subscription;
    // Uma renovação aberta no plano de antes não pode desfazer o upgrade: expira as abertas.
    await this.deps.checkout.expireOpenRenewals(account.id);
    return this.issueOrder(account, ev.entry, ev.price, request, 'UPGRADE', plan.cents, now, {
      planCode: sub.plan.code,
      cycle: sub.cycle,
      agenda: sub.agendaEnabled,
      stock: sub.stockEnabled,
      periodStart: sub.currentPeriodStart.toISOString(),
      periodEnd: sub.currentPeriodEnd.toISOString(),
    });
  }

  /**
   * Downgrade, retirada de módulo ou mudança de ciclo: só GRAVA a troca (pendingChange) para a próxima
   * renovação, sem cobrança e sem mudar nada agora. Recusa se a conta tem mais empresas (inclusive não
   * adotadas) que o plano novo comporta.
   */
  async scheduleChange(accountId: string, input: ChangeRequest): Promise<PendingChange> {
    const now = this.deps.now?.() ?? new Date();
    const ev = await this.evaluate(accountId, input, now);
    const request = ev.target;
    if (!ev.paidAndInForce || ev.subscription.status === 'TRIAL') {
      throw new ConflictError('Não há plano pago em vigor; escolha o plano ao assinar', {
        code: 'PLAN_CHANGE_UNAVAILABLE',
      });
    }
    if (ev.relation === 'same') {
      throw new ConflictError('A escolha é igual ao plano atual', { code: 'NO_CHANGE' });
    }
    if (ev.relation === 'up') {
      throw new ConflictError('Para subir de plano use o upgrade', { code: 'USE_UPGRADE' });
    }
    await this.assertFits(accountId, ev.entry);
    const change: PendingChange = {
      planCode: request.planCode,
      cycle: request.cycle,
      agenda: request.agenda,
      stock: request.stock,
    };
    await this.deps.checkout.expireOpenRenewals(accountId);
    await this.deps.checkout.setPendingChange(accountId, change);
    this.deps.logger.info({ accountId }, 'troca de plano agendada para a próxima renovação');
    return change;
  }

  /** Desfaz a troca agendada antes da renovação. */
  async undoPendingChange(accountId: string): Promise<void> {
    await this.requireSubscription(accountId);
    await this.deps.checkout.setPendingChange(accountId, null);
  }

  /** Cancelar no modelo de link por ciclo: marca o fim do período; nada é cobrado nem apagado. */
  async cancel(accountId: string): Promise<void> {
    const sub = await this.requirePaidInForce(accountId);
    if (!sub.cancelAtPeriodEnd) {
      await this.deps.checkout.expireOpenRenewals(accountId);
      await this.deps.checkout.setCancelAtPeriodEnd(accountId, true);
    }
  }

  /** Reativar antes do fim do período limpa a marca; depois de expirada é um pedido normal. */
  async reactivate(accountId: string): Promise<void> {
    const sub = await this.requirePaidInForce(accountId);
    if (sub.cancelAtPeriodEnd) await this.deps.checkout.setCancelAtPeriodEnd(accountId, false);
  }

  /** O estado que as rotas de troca devolvem depois de agir (sem dinheiro). */
  async changeState(accountId: string): Promise<{
    readonly cancelAtPeriodEnd: boolean;
    readonly pendingChange: PendingChange | null;
  }> {
    const sub = await this.requireSubscription(accountId);
    return { cancelAtPeriodEnd: sub.cancelAtPeriodEnd, pendingChange: sub.pendingChange };
  }

  private async requireSubscription(accountId: string): Promise<SubscriptionRecord> {
    const sub = await this.deps.billing.findSubscription(accountId);
    if (sub === null) {
      throw new ConflictError('Crie uma empresa antes de assinar um plano', {
        code: 'NO_SUBSCRIPTION',
      });
    }
    return sub;
  }

  private async requirePaidInForce(accountId: string): Promise<SubscriptionRecord> {
    const sub = await this.requireSubscription(accountId);
    const now = this.deps.now?.() ?? new Date();
    const access = resolveAccess(sub, now, this.deps.settings.graceDays).access;
    if (sub.status === 'TRIAL' || access === 'blocked') {
      throw new ConflictError('Não há plano pago em vigor', { code: 'PLAN_CHANGE_UNAVAILABLE' });
    }
    return sub;
  }

  /** Grava o pedido, cria o link e substitui os pedidos abertos do mesmo tipo. */
  private async issueOrder(
    account: { readonly id: string; readonly email: string },
    entry: CatalogEntry,
    price: PlanPriceRecord,
    request: OrderRequest,
    kind: PaymentOrderKindValue,
    amountCents: number,
    now: Date,
    upgradeBase?: UpgradeBase,
  ): Promise<CreatedOrder> {
    const { checkout, provider, settings, logger, metrics } = this.deps;
    const breakdown: OrderBreakdown = {
      planCode: request.planCode,
      cycle: request.cycle,
      agenda: request.agenda,
      stock: request.stock,
      priceId: price.id,
      priceVersion: price.version,
      whatsappBillingMode: price.whatsappBillingMode,
      ...(upgradeBase === undefined ? {} : { upgradeBase }),
    };
    const orderId = randomUUID();
    const expiresAt = new Date(now.getTime() + ORDER_VALIDITY_MS);
    // O pedido é gravado ANTES de chamar o provedor: o webhook sempre acha a linha.
    const order = await checkout.createPendingOrder(
      account.id,
      { id: orderId, kind, amountCents, breakdown, expiresAt },
      { since: new Date(now.getTime() - ORDER_VALIDITY_MS), max: ORDER_MAX_PER_DAY },
    );
    if (order === 'limit') {
      metrics?.countBillingOrder(kind, 'limit');
      throw new RateLimitError(3_600, 'Muitos pedidos hoje. Tente novamente mais tarde.', {
        code: 'ORDER_LIMIT_REACHED',
      });
    }
    if (order === null) {
      throw new ConflictError('Crie uma empresa antes de assinar um plano', {
        code: 'NO_SUBSCRIPTION',
      });
    }

    const link = await provider.createLink({
      orderId,
      amountCents,
      description: describe(entry.plan.code, request, kind),
      ...(settings.sendCustomerEmail ? { customerEmail: account.email } : {}),
      redirectUrl: `${settings.appOrigin}/painel/assinatura`,
      webhookUrl: `${settings.webhookBaseUrl}/webhooks/infinitepay/${orderId}/${webhookToken(settings.webhookSecret, orderId)}`,
      validUntil: expiresAt,
    });
    if (!link.ok) {
      // Nada fica pendente pendurado: o pedido sem link é apagado.
      await checkout.discardUnlinkedOrder(orderId);
      const reason = link.error.reason;
      metrics?.countBillingOrder(kind, reason === 'config' ? 'provider_config' : 'link_failed');
      if (reason === 'config') {
        logger.error(
          { accountId: account.id, orderRef: messageRef(orderId) },
          'provedor de pagamento recusou a credencial ao criar o link; confira INFINITEPAY_API_KEY e INFINITEPAY_HANDLE',
        );
      } else {
        logger.warn(
          {
            accountId: account.id,
            orderRef: messageRef(orderId),
            reason,
            ...(link.error.detail === undefined ? {} : { detail: link.error.detail }),
          },
          'não foi possível criar o link',
        );
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
    logger.info(
      { accountId: account.id, orderRef: messageRef(orderId), kind },
      'pedido de pagamento criado',
    );
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
   * Webhook: NÃO confia no corpo. Confere o token da URL (tempo constante) e o pedido; o corpo só dá
   * referências que servem de dica na segunda tentativa da consulta e NUNCA são gravadas antes de uma
   * confirmação paga. Token inválido, pedido desconhecido ou order_nsu diferente da rota: nada acontece e a
   * resposta é a mesma (nada vaza). A confirmação roda em segundo plano, deduplicada por pedido.
   */
  async acceptWebhook(
    orderId: string,
    token: string,
    event: WebhookEvent,
  ): Promise<WebhookOutcome> {
    const { checkout, verifier, metrics, settings } = this.deps;
    const count = (result: WebhookOutcome): WebhookOutcome => {
      metrics?.countBillingWebhook(result);
      return result;
    };
    if (!isUuid(orderId)) return count('unknown_order');
    if (!verifyWebhookToken(settings.webhookSecret, orderId, token)) return count('bad_token');
    if (event.orderNsu !== undefined && event.orderNsu !== orderId) return count('unknown_order');
    const order = await checkout.findOrderById(orderId);
    if (order === null) return count('unknown_order');
    if (order.status === 'PAID' || order.status === 'FAILED') return count('duplicate');
    const started = verifier.verifyInBackground(orderId, {
      transactionNsu: event.transactionNsu,
      slug: event.invoiceSlug,
    });
    return count(
      started === 'started' ? 'recorded' : started === 'duplicate' ? 'duplicate' : 'throttled',
    );
  }
}

function describe(code: PlanCode, request: OrderRequest, kind: PaymentOrderKindValue): string {
  const modules = [request.agenda ? 'Agenda' : null, request.stock ? 'Estoque' : null].filter(
    (value) => value !== null,
  );
  const cycle = request.cycle === 'ANNUAL' ? 'anual' : 'mensal';
  return `Soprei${kind === 'UPGRADE' ? ' upgrade' : ''} ${PLAN_DESCRIPTION[code]} ${cycle}${modules.length > 0 ? ` + ${modules.join(' e ')}` : ''}`;
}
