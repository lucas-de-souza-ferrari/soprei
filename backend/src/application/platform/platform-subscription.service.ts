import type { FastifyBaseLogger } from 'fastify';
import {
  AccountId,
  type PlanCode,
  type PlatformActionReason,
  type PlatformAuditAction,
  resolveAccess,
  type SubscriptionRecord,
} from '../../domain/index.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors/index.js';
import { isUuid } from '../../shared/utils/index.js';
import type { PlatformIdentity } from '../auth/identity.js';
import type {
  PlatformSubscriptionPatch,
  PlatformSubscriptionTransaction,
  PlatformSubscriptionUnitOfWork,
} from '../ports/platform-subscription-unit-of-work.js';
import { confirmPlatformAction, type PlatformActionConfirmer } from './platform-confirmation.js';

const DAY_MS = 86_400_000;
/** Dias que o admin pode conceder de uma vez (spec 045, E4). */
export const PLATFORM_EXTEND_MIN_DAYS = 1;
export const PLATFORM_EXTEND_MAX_DAYS = 90;

/** As regras da cobrança que as ações usam (as mesmas do servidor: `BILLING_*`). */
export interface PlatformSubscriptionSettings {
  readonly graceDays: number;
  readonly trialDays: number;
}

export interface PlatformSubscriptionServiceDeps {
  readonly subscriptions: PlatformSubscriptionUnitOfWork;
  readonly confirmer: PlatformActionConfirmer;
  /** Ausente = `BILLING_ENABLED=false`: toda ação responde 409 `BILLING_DISABLED` sem efeito. */
  readonly settings?: PlatformSubscriptionSettings | undefined;
  readonly logger: FastifyBaseLogger;
  readonly metrics?: Pick<Metrics, 'countPlatformAction'> | undefined;
  readonly now?: () => Date;
}

type PlatformActionMetric = Parameters<Metrics['countPlatformAction']>[0];

const METRIC: Partial<Record<PlatformAuditAction, PlatformActionMetric>> = {
  SUBSCRIPTION_TRIAL_STARTED: 'subscription_trial_started',
  SUBSCRIPTION_EXTENDED: 'subscription_extended',
  SUBSCRIPTION_MODULES_CHANGED: 'subscription_modules_changed',
  SUBSCRIPTION_PLAN_CHANGED: 'subscription_plan_changed',
  SUBSCRIPTION_CANCELLED: 'subscription_cancelled',
  SUBSCRIPTION_REACTIVATED: 'subscription_reactivated',
  SUBSCRIPTION_ENDED: 'subscription_ended',
};

function accountNotFound(): NotFoundError {
  return new NotFoundError('Conta não encontrada', { context: { entity: 'Account' } });
}

/**
 * Fim novo do período ao conceder `days` dias (spec 045, E4): a partir do maior entre agora e o fim atual (no
 * teste, o fim do teste). O início do período não muda, então o uso já contado na janela continua contando;
 * uma assinatura vencida há muito cai numa janela nova (os meses desde o início). Pura.
 */
export function extendedPeriodEnd(
  subscription: Pick<SubscriptionRecord, 'status' | 'currentPeriodEnd' | 'trialEndsAt'>,
  now: Date,
  days: number,
): Date {
  const currentEnd =
    subscription.status === 'TRIAL'
      ? (subscription.trialEndsAt ?? subscription.currentPeriodEnd)
      : subscription.currentPeriodEnd;
  return new Date(Math.max(now.getTime(), currentEnd.getTime()) + days * DAY_MS);
}

/**
 * Ações do admin da plataforma sobre a assinatura de uma conta (spec 045, E4): iniciar o teste gratuito,
 * conceder dias, ligar e desligar módulos, trocar o plano sem cobrança, cancelar e desfazer o cancelamento no
 * fim do período e encerrar agora (**[código]**). Cada uma: travas (empresas -> conta -> assinatura),
 * releitura, regra, escrita e `PlatformAuditEvent` na mesma transação. Com pedido de pagamento `PENDING`
 * válido = 409 `ORDER_PENDING` (um pedido pago depois de uma mudança do admin cairia em revisão manual).
 * Dinheiro nunca passa por aqui: nada de estorno, pedido ou link em nome da pessoa. Não conhece Fastify nem
 * Prisma; o log leva só `adminId`, ids, ação e motivo.
 */
export class PlatformSubscriptionService {
  constructor(private readonly deps: PlatformSubscriptionServiceDeps) {}

  /** Teste gratuito para conta SEM assinatura (409 `SUBSCRIPTION_EXISTS`); adota as empresas dela. */
  async startTrial(
    identity: PlatformIdentity,
    accountId: string,
    reason: PlatformActionReason,
  ): Promise<void> {
    const settings = this.requireBilling();
    const id = this.parseId(accountId);
    const action = 'SUBSCRIPTION_TRIAL_STARTED';
    await this.deps.subscriptions.run(async (tx) => {
      // As empresas que o teste adota são travadas antes da conta (a ordem de sempre).
      await tx.lockOwnedCompanies(id);
      if (!(await tx.lockAccount(id))) throw accountNotFound();
      if ((await tx.lockSubscription(id)) !== null) {
        throw new ConflictError('A conta já tem assinatura', { code: 'SUBSCRIPTION_EXISTS' });
      }
      await tx.startTrial(id, this.now(), settings.trialDays);
      await tx.audit({ adminId: identity.adminId, action, subjectAccountId: id, reason });
    });
    this.recorded(identity, id, action, reason);
  }

  /**
   * Concede 1 a 90 dias: soma ao fim do período (ou do teste) a partir do maior entre agora e o fim atual.
   * Assinatura vencida ou em carência volta a `ACTIVE`; o teste continua `TRIAL`. O uso já contado fica.
   */
  async extend(
    identity: PlatformIdentity,
    accountId: string,
    days: number,
    reason: PlatformActionReason,
  ): Promise<void> {
    this.requireBilling();
    const id = this.parseId(accountId);
    if (
      !Number.isInteger(days) ||
      days < PLATFORM_EXTEND_MIN_DAYS ||
      days > PLATFORM_EXTEND_MAX_DAYS
    ) {
      throw new ValidationError(
        `days deve ser inteiro de ${String(PLATFORM_EXTEND_MIN_DAYS)} a ${String(PLATFORM_EXTEND_MAX_DAYS)}`,
      );
    }
    const action = 'SUBSCRIPTION_EXTENDED';
    await this.mutate(identity, id, action, reason, { days }, (sub) => {
      const end = extendedPeriodEnd(sub, this.now(), days);
      return sub.status === 'TRIAL'
        ? { currentPeriodEnd: end, trialEndsAt: end }
        : { currentPeriodEnd: end, status: 'ACTIVE' };
    });
  }

  /**
   * Liga ou desliga Agenda e Estoque na hora, sem cobrança; a renovação seguinte cobra o que estiver ligado
   * (D13). No estado pedido: 204 sem evento.
   */
  async setModules(
    identity: PlatformIdentity,
    accountId: string,
    modules: { readonly agenda: boolean; readonly stock: boolean },
    reason: PlatformActionReason,
  ): Promise<boolean> {
    this.requireBilling();
    const id = this.parseId(accountId);
    return this.mutate(
      identity,
      id,
      'SUBSCRIPTION_MODULES_CHANGED',
      reason,
      { moduleSchedule: modules.agenda, moduleInventory: modules.stock },
      (sub) =>
        sub.agendaEnabled === modules.agenda && sub.stockEnabled === modules.stock
          ? null
          : { agendaEnabled: modules.agenda, stockEnabled: modules.stock },
    );
  }

  /**
   * Troca o plano na hora, no mesmo ciclo, sem cobrança, com a trava de empresas (409
   * `PLAN_DOWNGRADE_BLOCKED`, contando as não adotadas); apaga a troca agendada. A renovação seguinte cobra
   * o plano novo (D13). O mesmo plano: 204 sem evento.
   */
  async changePlan(
    identity: PlatformIdentity,
    accountId: string,
    planCode: PlanCode,
    reason: PlatformActionReason,
  ): Promise<boolean> {
    this.requireBilling();
    const id = this.parseId(accountId);
    return this.mutate(
      identity,
      id,
      'SUBSCRIPTION_PLAN_CHANGED',
      reason,
      { planCode },
      async (sub, tx) => {
        if (sub.plan.code === planCode) return null;
        const target = await tx.planTarget(planCode, sub.cycle, this.now());
        if (target === null) {
          throw new ConflictError('O plano não está no catálogo vigente', {
            code: 'PLAN_UNAVAILABLE',
          });
        }
        if ((await tx.countCompanies(id)) > target.maxCompanies) {
          throw new ConflictError('O plano não comporta as empresas da conta', {
            code: 'PLAN_DOWNGRADE_BLOCKED',
          });
        }
        return { planId: target.planId, priceId: target.priceId, clearPendingChange: true };
      },
    );
  }

  /**
   * Cancela no fim do período (`cancel = true`) ou desfaz o cancelamento, com as regras da 031: sem
   * assinatura paga em vigor = 409 `PLAN_CHANGE_UNAVAILABLE`. No estado pedido: 204 sem evento.
   */
  async setCancelAtPeriodEnd(
    identity: PlatformIdentity,
    accountId: string,
    cancel: boolean,
    reason: PlatformActionReason,
  ): Promise<boolean> {
    const settings = this.requireBilling();
    const id = this.parseId(accountId);
    return this.mutate(
      identity,
      id,
      cancel ? 'SUBSCRIPTION_CANCELLED' : 'SUBSCRIPTION_REACTIVATED',
      reason,
      {},
      (sub) => {
        const { access } = resolveAccess(sub, this.now(), settings.graceDays);
        if (sub.status === 'TRIAL' || access === 'blocked') {
          throw new ConflictError('Não há plano pago em vigor', {
            code: 'PLAN_CHANGE_UNAVAILABLE',
          });
        }
        return sub.cancelAtPeriodEnd === cancel ? null : { cancelAtPeriodEnd: cancel };
      },
    );
  }

  /**
   * Encerra agora (**[código]**, D14): `EXPIRED`, fim do período agora, sem carência. O atendimento das
   * empresas da conta para (gate e cota). A linha, os pedidos, o uso e os avisos ficam (guarda fiscal).
   * Já encerrada: 204 sem evento.
   */
  async end(
    identity: PlatformIdentity,
    accountId: string,
    reason: PlatformActionReason,
    code: string | undefined,
  ): Promise<boolean> {
    const settings = this.requireBilling();
    const id = this.parseId(accountId);
    await confirmPlatformAction(this.deps.confirmer, identity, code);
    return this.mutate(identity, id, 'SUBSCRIPTION_ENDED', reason, {}, (sub) => {
      const now = this.now();
      if (
        sub.status === 'EXPIRED' &&
        resolveAccess(sub, now, settings.graceDays).access === 'blocked'
      ) {
        return null;
      }
      return {
        status: 'EXPIRED',
        currentPeriodEnd: now,
        ...(sub.trialEndsAt === null ? {} : { trialEndsAt: now }),
        cancelAtPeriodEnd: true,
      };
    });
  }

  /**
   * O esqueleto comum: conta (404), assinatura (409 `NO_SUBSCRIPTION`), pedido pendente (409
   * `ORDER_PENDING`), a regra (`null` = já no estado pedido: sem escrita nem evento), a escrita e a trilha.
   */
  private async mutate(
    identity: PlatformIdentity,
    accountId: AccountId,
    action: PlatformAuditAction,
    reason: PlatformActionReason,
    details: {
      readonly planCode?: PlanCode;
      readonly days?: number;
      readonly moduleSchedule?: boolean;
      readonly moduleInventory?: boolean;
    },
    decide: (
      subscription: SubscriptionRecord,
      tx: PlatformSubscriptionTransaction,
    ) => PlatformSubscriptionPatch | null | Promise<PlatformSubscriptionPatch | null>,
  ): Promise<boolean> {
    const changed = await this.deps.subscriptions.run(async (tx) => {
      if (!(await tx.lockAccount(accountId))) throw accountNotFound();
      const subscription = await tx.lockSubscription(accountId);
      if (subscription === null) {
        throw new ConflictError('A conta não tem assinatura', { code: 'NO_SUBSCRIPTION' });
      }
      if (await tx.hasPendingOrder(subscription.id, this.now())) {
        throw new ConflictError('Há um pedido de pagamento pendente desta assinatura', {
          code: 'ORDER_PENDING',
        });
      }
      const patch = await decide(subscription, tx);
      if (patch === null) return false;
      await tx.update(subscription.id, patch);
      await tx.audit({
        adminId: identity.adminId,
        action,
        subjectAccountId: accountId,
        reason,
        ...details,
      });
      return true;
    });
    if (changed) this.recorded(identity, accountId, action, reason);
    return changed;
  }

  private requireBilling(): PlatformSubscriptionSettings {
    if (this.deps.settings === undefined) {
      throw new ConflictError('A cobrança está desligada', { code: 'BILLING_DISABLED' });
    }
    return this.deps.settings;
  }

  private parseId(accountId: string): AccountId {
    if (!isUuid(accountId)) throw accountNotFound();
    return AccountId.parse(accountId);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private recorded(
    identity: PlatformIdentity,
    accountId: AccountId,
    action: PlatformAuditAction,
    reason: PlatformActionReason,
  ): void {
    const metric = METRIC[action];
    try {
      if (metric !== undefined) this.deps.metrics?.countPlatformAction(metric);
    } catch (error) {
      this.deps.logger.warn({ err: error }, 'falha ao registrar métrica da plataforma');
    }
    this.deps.logger.info(
      { adminId: identity.adminId, accountId, action, reason },
      'admin da plataforma agiu sobre uma assinatura',
    );
  }
}
