import type { FastifyBaseLogger } from 'fastify';
import {
  type AccessLevel,
  AccountId,
  type AccessStatus,
  type BillingCycle,
  type BillingNoticeKind,
  CompanyId,
  type CompanyStatus,
  type MembershipRole,
  PLAN_CODES,
  type PendingChange,
  type PlanCode,
  type PlatformActionReason,
  type PlatformAuditRepository,
  quotaLimits,
  resolveAccess,
  SUBSCRIPTION_STATUSES,
  type SubscriptionStatus,
  usageWindowEnd,
} from '../../domain/index.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import {
  DatabaseError,
  NotFoundError,
  ServiceUnavailableError,
} from '../../shared/errors/index.js';
import type { Result } from '../../shared/types/index.js';
import { isUuid } from '../../shared/utils/index.js';
import type { PlatformIdentity } from '../auth/identity.js';
import type { ResumeRunReport } from '../channel/attendance-resumer.js';
import type { OnboardingStore } from '../ports/onboarding-store.js';
import type { PlatformCompanyUnitOfWork } from '../ports/platform-company-unit-of-work.js';
import type { PlatformProcessCounters } from '../ports/platform-health.js';
import type {
  PlatformAccountListFilter,
  PlatformAccountRow,
  PlatformAttendanceVolume,
  PlatformAttentionCounts,
  PlatformChannelMode,
  PlatformChannelState,
  PlatformChannelView,
  PlatformCompanyAttendance,
  PlatformCompanyListFilter,
  PlatformCompanyOwner,
  PlatformCompanyPerson,
  PlatformNoticeRow,
  PlatformOrderFilter,
  PlatformOrderRow,
  PlatformPage,
  PlatformPageRequest,
  PlatformReadModel,
  PlatformSubscriptionFacts,
  PlatformSubscriptionGroup,
  PlatformSubscriptionSnapshot,
} from '../ports/platform-read-model.js';
import { PLATFORM_TOKEN_EXPIRY_SOON_MS } from '../ports/platform-read-model.js';

const DAY_MS = 86_400_000;
/** Prazo da leitura da fila na Saúde (spec 044): passou disso, a fila aparece como `unavailable`. */
export const PLATFORM_QUEUE_READ_TIMEOUT_MS = 1_000;
/** Brasília (UTC-3, sem horário de verão desde 2019): o "mês corrente" dos pedidos pagos. */
const BRASILIA_OFFSET_MS = 3 * 3_600_000;

// ---------------------------------------------------------------------------------------------------
// Contratos de resposta (o app `admin/` da E3 consome estes formatos; datas viram texto ISO no JSON).
// ---------------------------------------------------------------------------------------------------

export interface PlatformOverview {
  readonly generatedAt: Date;
  /** `BILLING_ENABLED`; desligada, os blocos de cobrança vêm `null`. */
  readonly billingEnabled: boolean;
  readonly companies: { readonly active: number; readonly suspended: number };
  readonly accounts: {
    readonly total: number;
    readonly verified: number;
    readonly unverified: number;
    readonly disabled: number;
  };
  /** `null` com a cobrança desligada. */
  readonly subscriptions: {
    readonly byState: Readonly<Record<SubscriptionStatus, number>>;
    readonly byPlan: Readonly<Record<PlanCode, number>>;
    readonly byAccess: Readonly<Record<AccessLevel, number>>;
  } | null;
  readonly channel: {
    readonly byState: Readonly<Record<PlatformChannelState, number>>;
    readonly byMode: Readonly<Record<PlatformChannelMode, number>>;
  };
  readonly attendance: {
    readonly last24h: PlatformAttendanceVolume;
    readonly last7d: PlatformAttendanceVolume;
  };
  readonly attention: PlatformAttentionCounts;
  /** Pedidos pagos desde o início do mês corrente (horário de Brasília); `null` com a cobrança desligada. */
  readonly paidOrdersThisMonth: {
    readonly monthStart: Date;
    readonly count: number;
    readonly amountCents: number;
  } | null;
}

export interface PlatformCompanyListItem {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: CompanyStatus;
  readonly createdAt: Date;
  readonly lastActivityAt: Date | null;
  /** `null` sem assinatura ou com a cobrança desligada. */
  readonly plan: PlanCode | null;
  readonly access: AccessLevel | null;
  readonly channelState: PlatformChannelState;
  readonly activeMembers: number;
  /** Mensagens do contato nos últimos 7 dias. */
  readonly messages7d: number;
  /** O dono ativo mais antigo, mascarado; `null` sem dono ativo (spec 045, E1). */
  readonly owner: PlatformCompanyOwner | null;
  /** Quantos donos ativos (`0`: empresa sem dono ativo). */
  readonly owners: number;
}

export interface PlatformSubscriptionView {
  readonly id: string;
  readonly plan: { readonly code: PlanCode; readonly name: string };
  readonly cycle: BillingCycle;
  readonly modules: { readonly schedule: boolean; readonly inventory: boolean };
  /** Estado gravado. */
  readonly status: SubscriptionStatus;
  /** Estado efetivo agora (`resolveAccess`). */
  readonly state: SubscriptionStatus;
  readonly access: AccessLevel;
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
  readonly trialEndsAt: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly pendingChange: PendingChange | null;
}

export interface PlatformUsageView {
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly replies: { readonly used: number; readonly limit: number };
  readonly tokens: { readonly used: number; readonly limit: number };
}

export interface PlatformCompanyDetail {
  readonly billingEnabled: boolean;
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: CompanyStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** Só se existe persona; o texto nunca sai. */
  readonly hasPersona: boolean;
  /** Primeiros passos (spec 030), só booleanos. */
  readonly onboarding: {
    readonly dismissed: boolean;
    readonly steps: {
      readonly persona: boolean;
      readonly knowledge: boolean;
      readonly schedule: boolean;
      readonly inventory: boolean;
    };
  };
  /** Módulos liberados agora (cobrança desligada: tudo liberado; sem assinatura: nada). */
  readonly modules: { readonly schedule: boolean; readonly inventory: boolean };
  readonly memberships: readonly {
    readonly role: MembershipRole;
    readonly status: AccessStatus;
    readonly count: number;
  }[];
  /** Pessoas da empresa (spec 045, E1): até 50, dono primeiro, e-mail mascarado. */
  readonly people: readonly PlatformCompanyPerson[];
  readonly peopleTotal: number;
  /** O dono ativo mais antigo, mascarado (o app só exibe; a regra é a do servidor). */
  readonly owner: PlatformCompanyOwner | null;
  /** Quantos donos ativos (`0`: o app avisa "Empresa sem dono ativo"). */
  readonly owners: number;
  readonly pendingInvitations: number;
  /** Titular da ASSINATURA (quem paga), não o dono da empresa. */
  readonly holder: {
    readonly accountId: string;
    readonly emailVerified: boolean;
    readonly status: AccessStatus;
    readonly createdAt: Date;
  } | null;
  /** `null` sem assinatura ou com a cobrança desligada. */
  readonly subscription: PlatformSubscriptionView | null;
  readonly usage: PlatformUsageView | null;
  readonly channel: PlatformChannelView;
  readonly attendance: {
    readonly last24h: PlatformCompanyAttendance;
    readonly last7d: PlatformCompanyAttendance;
    readonly last30d: PlatformCompanyAttendance;
  };
  readonly attention: {
    readonly stalledPending: number;
    readonly unsentReplies: number;
    readonly openHandoffs: number;
    readonly tokenInvalid: boolean;
    readonly tokenExpiringSoon: boolean;
  };
  readonly content: {
    readonly documents: number;
    readonly activeProducts: number;
    readonly upcomingAppointments: number;
  };
}

export type PlatformAccountListItem = PlatformAccountRow;

export interface PlatformAccountDetail {
  readonly billingEnabled: boolean;
  readonly id: string;
  /** Mascarado (spec 045, D3); o completo só por `GET .../email`, que grava `ACCOUNT_EMAIL_VIEWED`. */
  readonly emailMasked: string;
  readonly status: AccessStatus;
  readonly verified: boolean;
  readonly createdAt: Date;
  readonly companies: readonly {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly status: CompanyStatus;
    readonly role: MembershipRole;
    readonly membershipStatus: AccessStatus;
  }[];
  /** `null` sem assinatura ou com a cobrança desligada. */
  readonly subscription: PlatformSubscriptionView | null;
}

/** Listas da cobrança: com ela desligada, `billingEnabled: false` e nenhuma linha. */
export interface PlatformBillingPage<T> extends PlatformPage<T> {
  readonly billingEnabled: boolean;
}

export type PlatformQueueHealth =
  | { readonly state: 'disabled' }
  | { readonly state: 'unavailable' }
  | { readonly state: 'ok'; readonly jobs: Readonly<Record<string, number>> };

export type PlatformResumeHealth =
  | { readonly state: 'disabled' }
  | { readonly state: 'not_run' }
  | ({ readonly state: 'ran' } & ResumeRunReport);

export interface PlatformHealth {
  readonly checkedAt: Date;
  readonly bootedAt: Date;
  readonly database: 'up' | 'down';
  readonly redis: 'up' | 'down';
  readonly queue: PlatformQueueHealth;
  readonly resume: PlatformResumeHealth;
  readonly counters: PlatformProcessCounters;
}

// ---------------------------------------------------------------------------------------------------

export interface PlatformBillingSettings {
  readonly graceDays: number;
  readonly trialTokens: number;
  readonly trialReplies: number;
}

export interface PlatformHealthSources {
  readonly database: () => Promise<Result<void>>;
  readonly redis: () => Promise<Result<void>>;
  /** Fila do canal; ausente com o canal desligado (`disabled`). */
  readonly queue?: { jobCounts(): Promise<Record<string, number>> } | undefined;
  /** Retomada da 035; ausente com o canal desligado ou o intervalo em 0 (`disabled`). */
  readonly resumer?: { lastRun(): ResumeRunReport | null } | undefined;
  readonly counters: () => Promise<PlatformProcessCounters>;
  readonly bootedAt: Date;
}

export interface PlatformMonitorServiceDeps {
  readonly reads: PlatformReadModel;
  readonly onboarding: Pick<OnboardingStore, 'read'>;
  readonly companies: PlatformCompanyUnitOfWork;
  readonly audit: Pick<PlatformAuditRepository, 'create'>;
  /** Cobrança ligada (`BILLING_ENABLED`); ausente: assinatura, uso e pedidos vêm `null`. */
  readonly billing?: PlatformBillingSettings | undefined;
  readonly health: PlatformHealthSources;
  readonly logger: FastifyBaseLogger;
  readonly metrics?: Pick<Metrics, 'countPlatformAction'> | undefined;
  readonly now?: () => Date;
}

function zeroRecord<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

function companyNotFound(): NotFoundError {
  return new NotFoundError('Empresa não encontrada', { context: { entity: 'Company' } });
}

function accountNotFound(): NotFoundError {
  return new NotFoundError('Conta não encontrada', { context: { entity: 'Account' } });
}

/**
 * O estado efetivo de um grupo de assinaturas, pela regra do domínio (`resolveAccess`). O grupo diz só de
 * que lado de cada prazo `now` está; aqui viram instantes representativos (antes ou depois de `now`) que
 * levam a regra ao mesmo ramo.
 */
export function groupAccess(
  group: Pick<
    PlatformSubscriptionGroup,
    'status' | 'cancelAtPeriodEnd' | 'trialOpen' | 'periodOpen' | 'graceOpen'
  >,
  now: Date,
  graceDays: number,
): { readonly state: SubscriptionStatus; readonly access: AccessLevel } {
  const t = now.getTime();
  const grace = Math.max(0, graceDays) * DAY_MS;
  const periodEnd = group.periodOpen ? t + 1 : group.graceOpen ? t : t - grace - 1;
  return resolveAccess(
    {
      status: group.status,
      cancelAtPeriodEnd: group.cancelAtPeriodEnd,
      currentPeriodEnd: new Date(periodEnd),
      trialEndsAt: new Date(group.trialOpen ? t + 1 : t - 1),
    },
    now,
    graceDays,
  );
}

/** Início do mês corrente no horário de Brasília (UTC-3), como instante UTC. */
export function brasiliaMonthStart(now: Date): Date {
  const local = new Date(now.getTime() - BRASILIA_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) + BRASILIA_OFFSET_MS);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('prazo esgotado'));
    }, ms);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('falha'));
      },
    );
  });
}

/**
 * Falha do banco numa leitura que não passa pelo `PlatformReadModel` (o Primeiros passos do detalhe): o
 * mesmo 503 sem detalhe das leituras agregadas (revisão da E2, M2), em vez do 500 do `DatabaseError`.
 */
function readUnavailable(operation: string): (error: unknown) => never {
  return (error: unknown) => {
    if (error instanceof DatabaseError) {
      throw new ServiceUnavailableError('Leitura do admin indisponível', {
        cause: error,
        context: { operation },
      });
    }
    throw error;
  };
}

/**
 * Leituras e ações do admin da plataforma (spec 044, E2; pessoas e dono na 045, E1). Não conhece Fastify
 * nem Prisma. Só números, estados, datas, ids, nome e slug de empresa, e-mails mascarados e (D7) o e-mail
 * completo da conta só em `accountEmail`, com trilha. Nunca loga
 * e-mail, nome nem conteúdo: só ids, ação e motivo.
 */
export class PlatformMonitorService {
  private readonly now: () => Date;

  constructor(private readonly deps: PlatformMonitorServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async overview(): Promise<PlatformOverview> {
    const now = this.now();
    const billing = this.deps.billing;
    const monthStart = brasiliaMonthStart(now);
    const [facts, billingFacts] = await Promise.all([
      this.deps.reads.overview(now),
      billing === undefined
        ? Promise.resolve(null)
        : this.deps.reads.billingOverview(now, billing.graceDays, monthStart),
    ]);
    let subscriptions: PlatformOverview['subscriptions'] = null;
    if (billing !== undefined && billingFacts !== null) {
      const byState = zeroRecord(SUBSCRIPTION_STATUSES);
      const byPlan = zeroRecord(PLAN_CODES);
      const byAccess = zeroRecord<AccessLevel>(['ok', 'grace', 'blocked']);
      for (const group of billingFacts.subscriptions) {
        const { state, access } = groupAccess(group, now, billing.graceDays);
        byState[state] += group.count;
        byPlan[group.planCode] += group.count;
        byAccess[access] += group.count;
      }
      subscriptions = { byState, byPlan, byAccess };
    }
    return {
      generatedAt: now,
      billingEnabled: billing !== undefined,
      companies: facts.companies,
      accounts: facts.accounts,
      subscriptions,
      channel: facts.channel,
      attendance: facts.attendance,
      attention: facts.attention,
      paidOrdersThisMonth:
        billingFacts === null ? null : { monthStart, ...billingFacts.paidOrders },
    };
  }

  async listCompanies(
    filter: PlatformCompanyListFilter,
    page: PlatformPageRequest,
  ): Promise<PlatformPage<PlatformCompanyListItem>> {
    const now = this.now();
    const result = await this.deps.reads.listCompanies(filter, page, now);
    return {
      items: result.items.map((row) => {
        const subscription = this.snapshotAccess(row.subscription, now);
        return {
          id: row.id,
          name: row.name,
          slug: row.slug,
          status: row.status,
          createdAt: row.createdAt,
          lastActivityAt: row.lastActivityAt,
          plan: subscription?.planCode ?? null,
          access: subscription?.access ?? null,
          channelState: row.channelState,
          activeMembers: row.activeMembers,
          messages7d: row.messages7d,
          owner: row.owner,
          owners: row.owners,
        };
      }),
      nextCursor: result.nextCursor,
    };
  }

  /** Detalhe de uma empresa; id malformado, inexistente ou removido: 404. */
  async companyDetail(companyId: string): Promise<PlatformCompanyDetail> {
    if (!isUuid(companyId)) throw companyNotFound();
    const now = this.now();
    const facts = await this.deps.reads.companyDetail(CompanyId.parse(companyId), now);
    if (facts === null) throw companyNotFound();
    const id = facts.company.id;
    const [onboarding, subscriptionFacts] = await Promise.all([
      this.deps.onboarding
        .read(id, { persona: true, knowledge: true, schedule: true, inventory: true })
        .catch(readUnavailable('PlatformMonitor.onboarding')),
      this.deps.billing === undefined || facts.subscriptionId === null
        ? Promise.resolve(null)
        : this.deps.reads.subscription({ subscriptionId: facts.subscriptionId }, now),
    ]);
    const subscription =
      subscriptionFacts === null ? null : this.subscriptionView(subscriptionFacts, now);
    const modules =
      this.deps.billing === undefined
        ? { schedule: true, inventory: true }
        : (subscription?.modules ?? { schedule: false, inventory: false });
    const channel = facts.channel;
    const expiresAt = channel.tokenExpiresAt?.getTime();
    return {
      billingEnabled: this.deps.billing !== undefined,
      ...facts.company,
      hasPersona: onboarding.persona,
      onboarding: {
        dismissed: onboarding.dismissed,
        steps: {
          persona: onboarding.persona,
          knowledge: onboarding.knowledge,
          schedule: onboarding.schedule,
          inventory: onboarding.inventory,
        },
      },
      modules,
      memberships: facts.memberships,
      people: facts.people,
      peopleTotal: facts.peopleTotal,
      owner: facts.owner,
      owners: facts.owners,
      pendingInvitations: facts.pendingInvitations,
      holder: facts.holder,
      subscription,
      usage: subscriptionFacts === null ? null : this.usageView(subscriptionFacts),
      channel,
      attendance: facts.attendance,
      attention: {
        ...facts.attention,
        tokenInvalid: channel.state === 'TOKEN_INVALID',
        tokenExpiringSoon:
          channel.state === 'CONNECTED' &&
          expiresAt !== undefined &&
          expiresAt >= now.getTime() &&
          expiresAt < now.getTime() + PLATFORM_TOKEN_EXPIRY_SOON_MS,
      },
      content: facts.content,
    };
  }

  listAccounts(
    filter: PlatformAccountListFilter,
    page: PlatformPageRequest,
  ): Promise<PlatformPage<PlatformAccountListItem>> {
    return this.deps.reads.listAccounts(filter, page);
  }

  /**
   * Detalhe da conta com o e-mail MASCARADO (spec 045, D3): não grava nada, para que abrir a conta a
   * partir da empresa não conte como leitura do e-mail. Id malformado ou inexistente: 404.
   */
  async accountDetail(accountId: string): Promise<PlatformAccountDetail> {
    if (!isUuid(accountId)) throw accountNotFound();
    const now = this.now();
    const account = await this.deps.reads.accountDetail(accountId);
    if (account === null) throw accountNotFound();
    const subscriptionFacts =
      this.deps.billing === undefined
        ? null
        : await this.deps.reads.subscription({ accountId: account.id }, now);
    return {
      billingEnabled: this.deps.billing !== undefined,
      ...account,
      subscription:
        subscriptionFacts === null ? null : this.subscriptionView(subscriptionFacts, now),
    };
  }

  /**
   * O e-mail completo da conta (D7 da 044, D3 da 045): a única saída dele no admin. Grava
   * `ACCOUNT_EMAIL_VIEWED` ANTES de devolver: sem registro, o e-mail não sai. Id malformado ou inexistente:
   * 404 (e nada gravado). O log leva só `adminId` e `accountId`.
   */
  async accountEmail(
    identity: PlatformIdentity,
    accountId: string,
  ): Promise<{ readonly email: string }> {
    if (!isUuid(accountId)) throw accountNotFound();
    const email = await this.deps.reads.accountEmail(accountId);
    if (email === null) throw accountNotFound();
    await this.deps.audit.create({
      adminId: identity.adminId,
      action: 'ACCOUNT_EMAIL_VIEWED',
      subjectAccountId: AccountId.parse(accountId),
    });
    this.countAction('account_email_viewed');
    this.deps.logger.info(
      { adminId: identity.adminId, accountId },
      'admin da plataforma leu o e-mail de uma conta',
    );
    return { email };
  }

  async listOrders(
    filter: PlatformOrderFilter,
    page: PlatformPageRequest,
  ): Promise<PlatformBillingPage<PlatformOrderRow>> {
    if (this.deps.billing === undefined)
      return { billingEnabled: false, items: [], nextCursor: null };
    return { billingEnabled: true, ...(await this.deps.reads.listOrders(filter, page)) };
  }

  async listNotices(
    filter: { readonly kind?: BillingNoticeKind | undefined },
    page: PlatformPageRequest,
  ): Promise<PlatformBillingPage<PlatformNoticeRow>> {
    if (this.deps.billing === undefined)
      return { billingEnabled: false, items: [], nextCursor: null };
    return { billingEnabled: true, ...(await this.deps.reads.listNotices(filter, page)) };
  }

  /**
   * Suspende (`SUSPENDED`) ou reativa (`ACTIVE`) a empresa: trava, estado e trilha na mesma transação.
   * Idempotente: se já está no estado pedido, nada é gravado (nem outro evento). Devolve se mudou.
   */
  async setCompanyStatus(
    identity: PlatformIdentity,
    companyId: string,
    target: CompanyStatus,
    reason: PlatformActionReason,
  ): Promise<boolean> {
    if (!isUuid(companyId)) throw companyNotFound();
    const id = CompanyId.parse(companyId);
    const action = target === 'SUSPENDED' ? 'COMPANY_SUSPENDED' : 'COMPANY_REACTIVATED';
    const changed = await this.deps.companies.run(async (tx) => {
      const current = await tx.lockCompany(id);
      if (current === target) return false;
      await tx.setStatus(id, target);
      await tx.audit({ adminId: identity.adminId, action, subjectCompanyId: id, reason });
      return true;
    });
    if (changed) {
      this.countAction(target === 'SUSPENDED' ? 'company_suspended' : 'company_reactivated');
      this.deps.logger.info(
        { adminId: identity.adminId, companyId: id, action, reason },
        'admin da plataforma mudou o estado de uma empresa',
      );
    }
    return changed;
  }

  async health(): Promise<PlatformHealth> {
    const sources = this.deps.health;
    const [database, redis, queue, counters] = await Promise.all([
      sources.database(),
      sources.redis(),
      this.queueHealth(),
      sources.counters(),
    ]);
    if (!database.ok) this.deps.logger.warn({ err: database.error }, 'saúde: banco indisponível');
    if (!redis.ok) this.deps.logger.warn({ err: redis.error }, 'saúde: Redis indisponível');
    const last = sources.resumer?.lastRun() ?? null;
    const resume: PlatformResumeHealth =
      sources.resumer === undefined
        ? { state: 'disabled' }
        : last === null
          ? { state: 'not_run' }
          : { state: 'ran', ...last };
    return {
      checkedAt: this.now(),
      bootedAt: sources.bootedAt,
      database: database.ok ? 'up' : 'down',
      redis: redis.ok ? 'up' : 'down',
      queue,
      resume,
      counters,
    };
  }

  private async queueHealth(): Promise<PlatformQueueHealth> {
    const queue = this.deps.health.queue;
    if (queue === undefined) return { state: 'disabled' };
    try {
      const counts = await withTimeout(queue.jobCounts(), PLATFORM_QUEUE_READ_TIMEOUT_MS);
      const jobs: Record<string, number> = {};
      for (const [state, value] of Object.entries(counts)) {
        if (Number.isFinite(value)) jobs[state] = value;
      }
      return { state: 'ok', jobs };
    } catch {
      // Nunca o erro do BullMQ/ioredis inteiro (carrega `command.args`): só o fato.
      this.deps.logger.warn({ queue: 'inbound' }, 'saúde: fila do canal inalcançável');
      return { state: 'unavailable' };
    }
  }

  private snapshotAccess(
    snapshot: PlatformSubscriptionSnapshot | null,
    now: Date,
  ): { readonly planCode: PlanCode; readonly access: AccessLevel } | null {
    const billing = this.deps.billing;
    if (billing === undefined || snapshot === null) return null;
    return {
      planCode: snapshot.planCode,
      access: resolveAccess(snapshot, now, billing.graceDays).access,
    };
  }

  private subscriptionView(facts: PlatformSubscriptionFacts, now: Date): PlatformSubscriptionView {
    const record = facts.record;
    const { state, access } = resolveAccess(record, now, this.deps.billing?.graceDays ?? 0);
    return {
      id: record.id,
      plan: { code: record.plan.code, name: record.plan.name },
      cycle: record.cycle,
      modules: { schedule: record.agendaEnabled, inventory: record.stockEnabled },
      status: record.status,
      state,
      access,
      currentPeriodStart: record.currentPeriodStart,
      currentPeriodEnd: record.currentPeriodEnd,
      trialEndsAt: record.trialEndsAt,
      cancelAtPeriodEnd: record.cancelAtPeriodEnd,
      pendingChange: record.pendingChange,
    };
  }

  private usageView(facts: PlatformSubscriptionFacts): PlatformUsageView {
    const billing = this.deps.billing ?? { trialTokens: 0, trialReplies: 0 };
    const limits = quotaLimits(facts.record, facts.usage.extraReplies, billing);
    return {
      windowStart: facts.windowStart,
      windowEnd: usageWindowEnd(facts.windowStart, facts.record.currentPeriodStart),
      replies: { used: facts.usage.sentMessages, limit: limits.replies },
      tokens: { used: facts.usage.tokens, limit: limits.tokens },
    };
  }

  private countAction(
    action: 'company_suspended' | 'company_reactivated' | 'account_email_viewed',
  ): void {
    try {
      this.deps.metrics?.countPlatformAction(action);
    } catch (error) {
      this.deps.logger.warn({ err: error }, 'falha ao registrar métrica da plataforma');
    }
  }
}
