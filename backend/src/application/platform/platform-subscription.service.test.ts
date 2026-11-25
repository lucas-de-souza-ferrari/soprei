import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  AccountId,
  type PlanCode,
  PlatformAdminId,
  resolveAccess,
  type SubscriptionRecord,
} from '../../domain/index.js';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import { InMemoryPlatformAuditRepository } from '../../test-support/in-memory-platform.js';
import { captureLogs } from '../../test-support/log-capture.js';
import type { LoginFailure } from '../auth/auth.service.js';
import type { PlatformIdentity } from '../auth/identity.js';
import type {
  PlatformSubscriptionPatch,
  PlatformSubscriptionTransaction,
  PlatformSubscriptionUnitOfWork,
} from '../ports/platform-subscription-unit-of-work.js';
import { CONFIRMATION_INVALID } from './platform-confirmation.js';
import { extendedPeriodEnd, PlatformSubscriptionService } from './platform-subscription.service.js';

const ADMIN: PlatformIdentity = {
  kind: 'platform',
  adminId: PlatformAdminId.parse(randomUUID()),
  sessionId: randomUUID(),
};
const CODE = '123456';
const DAY = 86_400_000;
const NOW = new Date('2026-11-25T12:00:00.000Z');
const SETTINGS = { graceDays: 5, trialDays: 7 };

const PLANS: Record<PlanCode, { readonly id: string; readonly maxCompanies: number }> = {
  ESSENTIAL: { id: randomUUID(), maxCompanies: 1 },
  PROFESSIONAL: { id: randomUUID(), maxCompanies: 3 },
  SCALE: { id: randomUUID(), maxCompanies: 10 },
};

function subscription(
  accountId: string,
  overrides: Partial<SubscriptionRecord> = {},
): SubscriptionRecord {
  return {
    id: randomUUID(),
    accountId,
    plan: {
      id: PLANS.PROFESSIONAL.id,
      code: 'PROFESSIONAL',
      name: 'Profissional',
      maxCompanies: 3,
      monthlyTokens: 48_000_000,
      monthlyReplies: 8_000,
      metaEstimateMilliCents: 0,
      version: 2,
    },
    price: {
      id: randomUUID(),
      cycle: 'MONTHLY',
      baseCents: 11_990,
      agendaCents: 2_990,
      stockCents: 2_990,
      whatsappBillingMode: 'CUSTOMER_PAYS_META',
      metaPerReplyMilliCents: 0,
      extraPackCents: 0,
      extraPackReplies: 0,
      version: 2,
      validFrom: new Date('2026-11-01T00:00:00.000Z'),
    },
    cycle: 'MONTHLY',
    agendaEnabled: false,
    stockEnabled: false,
    status: 'ACTIVE',
    currentPeriodStart: new Date(NOW.getTime() - 10 * DAY),
    currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY),
    trialEndsAt: null,
    cancelAtPeriodEnd: false,
    pendingChange: { planCode: 'ESSENTIAL', cycle: 'MONTHLY', agenda: false, stock: false },
    ...overrides,
  };
}

/** Unidade de trabalho em memória: grava só no fim (como o commit), registra a ordem das travas. */
class InMemorySubscriptions implements PlatformSubscriptionUnitOfWork {
  readonly accounts = new Set<string>();
  readonly subscriptions = new Map<string, SubscriptionRecord>();
  readonly pendingOrders = new Set<string>();
  readonly companies = new Map<string, number>();
  readonly locks: string[] = [];
  trialsStarted = 0;
  failAudit = false;

  constructor(readonly audit: InMemoryPlatformAuditRepository) {}

  async run<T>(fn: (tx: PlatformSubscriptionTransaction) => Promise<T>): Promise<T> {
    const staged = new Map(this.subscriptions);
    const events: Parameters<PlatformSubscriptionTransaction['audit']>[0][] = [];
    let trials = 0;
    const result = await fn({
      lockOwnedCompanies: (accountId) => {
        this.locks.push(`companies:${accountId}`);
        return Promise.resolve(0);
      },
      lockAccount: (accountId) => {
        this.locks.push(`account:${accountId}`);
        return Promise.resolve(this.accounts.has(accountId));
      },
      lockSubscription: (accountId) => {
        this.locks.push(`subscription:${accountId}`);
        return Promise.resolve(staged.get(accountId) ?? null);
      },
      hasPendingOrder: (subscriptionId) => Promise.resolve(this.pendingOrders.has(subscriptionId)),
      startTrial: (accountId, now, trialDays) => {
        const end = new Date(now.getTime() + trialDays * DAY);
        staged.set(
          accountId,
          subscription(accountId, {
            status: 'TRIAL',
            currentPeriodStart: now,
            currentPeriodEnd: end,
            trialEndsAt: end,
            agendaEnabled: true,
            stockEnabled: true,
            pendingChange: null,
          }),
        );
        trials += 1;
        return Promise.resolve(0);
      },
      planTarget: (planCode) =>
        Promise.resolve({
          planId: PLANS[planCode].id,
          priceId: `price-${planCode}`,
          maxCompanies: PLANS[planCode].maxCompanies,
        }),
      countCompanies: (accountId) => Promise.resolve(this.companies.get(accountId) ?? 0),
      update: (subscriptionId, patch: PlatformSubscriptionPatch) => {
        for (const [accountId, sub] of staged) {
          if (sub.id !== subscriptionId) continue;
          const code = (Object.keys(PLANS) as PlanCode[]).find(
            (key) => PLANS[key].id === patch.planId,
          );
          staged.set(accountId, {
            ...sub,
            ...(patch.status === undefined ? {} : { status: patch.status }),
            ...(patch.currentPeriodEnd === undefined
              ? {}
              : { currentPeriodEnd: patch.currentPeriodEnd }),
            ...(patch.trialEndsAt === undefined ? {} : { trialEndsAt: patch.trialEndsAt }),
            ...(patch.cancelAtPeriodEnd === undefined
              ? {}
              : { cancelAtPeriodEnd: patch.cancelAtPeriodEnd }),
            ...(patch.agendaEnabled === undefined ? {} : { agendaEnabled: patch.agendaEnabled }),
            ...(patch.stockEnabled === undefined ? {} : { stockEnabled: patch.stockEnabled }),
            ...(code === undefined
              ? {}
              : {
                  plan: {
                    ...sub.plan,
                    id: PLANS[code].id,
                    code,
                    maxCompanies: PLANS[code].maxCompanies,
                  },
                }),
            ...(patch.clearPendingChange === true ? { pendingChange: null } : {}),
          });
        }
        return Promise.resolve();
      },
      audit: (event) => {
        if (this.failAudit) return Promise.reject(new Error('trilha indisponível'));
        events.push(event);
        return Promise.resolve();
      },
    });
    for (const [key, value] of staged) this.subscriptions.set(key, value);
    this.trialsStarted += trials;
    for (const event of events) await this.audit.create(event);
    return result;
  }
}

interface World {
  readonly service: PlatformSubscriptionService;
  readonly uow: InMemorySubscriptions;
  readonly audit: InMemoryPlatformAuditRepository;
  readonly metrics: string[];
  readonly codes: (string | undefined)[];
  readonly logs: ReturnType<typeof captureLogs>;
  readonly account: AccountId;
  confirm: Result<void, LoginFailure>;
}

function setup(options: { billing?: boolean } = {}): World {
  const audit = new InMemoryPlatformAuditRepository();
  const uow = new InMemorySubscriptions(audit);
  const account = AccountId.parse(randomUUID());
  uow.accounts.add(account);
  uow.subscriptions.set(account, subscription(account));
  const metrics: string[] = [];
  const codes: (string | undefined)[] = [];
  const logs = captureLogs();
  const world = {
    uow,
    audit,
    metrics,
    codes,
    logs,
    account,
    confirm: Result.ok(undefined) as Result<void, LoginFailure>,
  };
  const service = new PlatformSubscriptionService({
    subscriptions: uow,
    confirmer: {
      confirmPlatformCode: (_adminId, code) => {
        codes.push(code);
        return Promise.resolve(world.confirm);
      },
    },
    settings: options.billing === false ? undefined : SETTINGS,
    logger: logs.logger,
    metrics: { countPlatformAction: (action) => metrics.push(action) },
    now: () => NOW,
  });
  return Object.assign(world, { service });
}

const sub = (world: World): SubscriptionRecord => {
  const found = world.uow.subscriptions.get(world.account);
  assert.ok(found);
  return found;
};

const code = (expected: string) => (error: unknown) =>
  error instanceof ConflictError && error.code === expected;

describe('PlatformSubscriptionService (spec 045, E4)', () => {
  it('cobrança desligada: toda ação = 409 BILLING_DISABLED, nada muda e o código não é gasto', async () => {
    const world = setup({ billing: false });
    const before = sub(world);
    await assert.rejects(
      world.service.startTrial(ADMIN, world.account, 'OTHER'),
      code('BILLING_DISABLED'),
    );
    await assert.rejects(
      world.service.extend(ADMIN, world.account, 10, 'OTHER'),
      code('BILLING_DISABLED'),
    );
    await assert.rejects(
      world.service.setModules(ADMIN, world.account, { agenda: true, stock: true }, 'OTHER'),
      code('BILLING_DISABLED'),
    );
    await assert.rejects(
      world.service.changePlan(ADMIN, world.account, 'SCALE', 'OTHER'),
      code('BILLING_DISABLED'),
    );
    await assert.rejects(
      world.service.setCancelAtPeriodEnd(ADMIN, world.account, true, 'OTHER'),
      code('BILLING_DISABLED'),
    );
    await assert.rejects(
      world.service.end(ADMIN, world.account, 'OTHER', CODE),
      code('BILLING_DISABLED'),
    );
    assert.deepEqual(sub(world), before);
    assert.deepEqual(world.codes, []);
    assert.equal(world.audit.events.length, 0);
  });

  it('conta inexistente ou id malformado = 404; conta sem assinatura = 409 NO_SUBSCRIPTION', async () => {
    const world = setup();
    await assert.rejects(world.service.extend(ADMIN, 'nao-uuid', 5, 'OTHER'), NotFoundError);
    await assert.rejects(world.service.extend(ADMIN, randomUUID(), 5, 'OTHER'), NotFoundError);
    world.uow.subscriptions.delete(world.account);
    await assert.rejects(
      world.service.extend(ADMIN, world.account, 5, 'OTHER'),
      code('NO_SUBSCRIPTION'),
    );
  });

  it('pedido de pagamento PENDING = 409 ORDER_PENDING em toda ação, sem efeito', async () => {
    const world = setup();
    world.uow.pendingOrders.add(sub(world).id);
    const before = sub(world);
    for (const attempt of [
      () => world.service.extend(ADMIN, world.account, 5, 'OTHER'),
      () => world.service.setModules(ADMIN, world.account, { agenda: true, stock: false }, 'OTHER'),
      () => world.service.changePlan(ADMIN, world.account, 'SCALE', 'OTHER'),
      () => world.service.setCancelAtPeriodEnd(ADMIN, world.account, true, 'OTHER'),
      () => world.service.end(ADMIN, world.account, 'OTHER', CODE),
    ]) {
      await assert.rejects(attempt(), code('ORDER_PENDING'));
    }
    assert.deepEqual(sub(world), before);
    assert.equal(world.audit.events.length, 0);
  });

  it('iniciar teste: só sem assinatura (409 SUBSCRIPTION_EXISTS); trava empresas, depois a conta', async () => {
    const world = setup();
    await assert.rejects(
      world.service.startTrial(ADMIN, world.account, 'OTHER'),
      code('SUBSCRIPTION_EXISTS'),
    );
    world.uow.subscriptions.delete(world.account);
    world.uow.locks.length = 0;
    await world.service.startTrial(ADMIN, world.account, 'OWNER_REQUEST');
    assert.equal(sub(world).status, 'TRIAL');
    assert.deepEqual(world.uow.locks, [
      `companies:${world.account}`,
      `account:${world.account}`,
      `subscription:${world.account}`,
    ]);
    assert.deepEqual(
      world.audit.events.map((event) => [event.action, event.subjectAccountId, event.reason]),
      [['SUBSCRIPTION_TRIAL_STARTED', world.account, 'OWNER_REQUEST']],
    );
    assert.deepEqual(world.metrics, ['subscription_trial_started']);
  });

  it('conceder dias: vencida além da carência volta ACTIVE até o novo fim; no teste estende o teste; trilha com days', async () => {
    const world = setup();
    world.uow.subscriptions.set(
      world.account,
      subscription(world.account, {
        status: 'EXPIRED',
        currentPeriodEnd: new Date(NOW.getTime() - 40 * DAY),
      }),
    );
    await world.service.extend(ADMIN, world.account, 30, 'PAYMENT');
    const extended = sub(world);
    assert.equal(extended.status, 'ACTIVE');
    assert.equal(extended.currentPeriodEnd.getTime(), NOW.getTime() + 30 * DAY);
    assert.equal(resolveAccess(extended, NOW, SETTINGS.graceDays).access, 'ok');
    assert.equal(world.audit.events[0]?.days, 30);

    const trial = setup();
    const trialEnd = new Date(NOW.getTime() + 2 * DAY);
    trial.uow.subscriptions.set(
      trial.account,
      subscription(trial.account, {
        status: 'TRIAL',
        currentPeriodStart: new Date(NOW.getTime() - 5 * DAY),
        currentPeriodEnd: trialEnd,
        trialEndsAt: trialEnd,
      }),
    );
    await trial.service.extend(ADMIN, trial.account, 10, 'OTHER');
    const t = sub(trial);
    assert.equal(t.status, 'TRIAL');
    assert.equal(t.trialEndsAt?.getTime(), trialEnd.getTime() + 10 * DAY);
    assert.equal(t.currentPeriodEnd.getTime(), trialEnd.getTime() + 10 * DAY);
    // O início do período (e com ele a janela de uso já contada) não muda.
    assert.equal(t.currentPeriodStart.getTime(), NOW.getTime() - 5 * DAY);
  });

  it('conceder dias fora de 1..90 = 400; o fim parte do maior entre agora e o fim atual', async () => {
    const world = setup();
    for (const days of [0, 91, 1.5]) {
      await assert.rejects(
        world.service.extend(ADMIN, world.account, days, 'OTHER'),
        ValidationError,
      );
    }
    const end = new Date(NOW.getTime() + 20 * DAY);
    assert.equal(
      extendedPeriodEnd(
        { status: 'ACTIVE', currentPeriodEnd: end, trialEndsAt: null },
        NOW,
        5,
      ).getTime(),
      end.getTime() + 5 * DAY,
    );
  });

  it('módulos: liga e desliga na hora com trilha dos dois; no estado pedido = sem evento', async () => {
    const world = setup();
    assert.equal(
      await world.service.setModules(
        ADMIN,
        world.account,
        { agenda: true, stock: false },
        'OWNER_REQUEST',
      ),
      true,
    );
    assert.equal(sub(world).agendaEnabled, true);
    assert.equal(sub(world).stockEnabled, false);
    const [event] = world.audit.events;
    assert.equal(event?.moduleSchedule, true);
    assert.equal(event.moduleInventory, false);
    assert.equal(
      await world.service.setModules(
        ADMIN,
        world.account,
        { agenda: true, stock: false },
        'OWNER_REQUEST',
      ),
      false,
    );
    assert.equal(world.audit.events.length, 1);
  });

  it('trocar plano: não comporta as empresas = 409 PLAN_DOWNGRADE_BLOCKED; comporta = troca e apaga a troca agendada', async () => {
    const world = setup();
    world.uow.companies.set(world.account, 2);
    await assert.rejects(
      world.service.changePlan(ADMIN, world.account, 'ESSENTIAL', 'OTHER'),
      code('PLAN_DOWNGRADE_BLOCKED'),
    );
    assert.equal(sub(world).plan.code, 'PROFESSIONAL');
    assert.equal(await world.service.changePlan(ADMIN, world.account, 'SCALE', 'OTHER'), true);
    assert.equal(sub(world).plan.code, 'SCALE');
    assert.equal(sub(world).pendingChange, null);
    assert.equal(world.audit.events[0]?.planCode, 'SCALE');
    assert.equal(await world.service.changePlan(ADMIN, world.account, 'SCALE', 'OTHER'), false);
    assert.equal(world.audit.events.length, 1);
  });

  it('cancelar e desfazer: só com plano pago em vigor (teste ou bloqueada = PLAN_CHANGE_UNAVAILABLE); idempotente', async () => {
    const world = setup();
    assert.equal(
      await world.service.setCancelAtPeriodEnd(ADMIN, world.account, true, 'OTHER'),
      true,
    );
    assert.equal(sub(world).cancelAtPeriodEnd, true);
    assert.equal(
      await world.service.setCancelAtPeriodEnd(ADMIN, world.account, true, 'OTHER'),
      false,
    );
    assert.equal(
      await world.service.setCancelAtPeriodEnd(ADMIN, world.account, false, 'OTHER'),
      true,
    );
    assert.deepEqual(
      world.audit.events.map((event) => event.action),
      ['SUBSCRIPTION_CANCELLED', 'SUBSCRIPTION_REACTIVATED'],
    );
    world.uow.subscriptions.set(world.account, subscription(world.account, { status: 'TRIAL' }));
    await assert.rejects(
      world.service.setCancelAtPeriodEnd(ADMIN, world.account, true, 'OTHER'),
      code('PLAN_CHANGE_UNAVAILABLE'),
    );
  });

  it('encerrar agora: exige o código; EXPIRED com o fim agora, sem carência; repetido = sem evento', async () => {
    const world = setup();
    await assert.rejects(
      world.service.end(ADMIN, world.account, 'ABUSE', undefined),
      (error: unknown) => error instanceof ValidationError && error.code === CONFIRMATION_INVALID,
    );
    world.confirm = Result.err({ reason: 'invalid_credentials' });
    await assert.rejects(
      world.service.end(ADMIN, world.account, 'ABUSE', CODE),
      (error: unknown) => error instanceof ValidationError && error.code === CONFIRMATION_INVALID,
    );
    assert.equal(sub(world).status, 'ACTIVE');
    world.confirm = Result.ok(undefined);
    assert.equal(await world.service.end(ADMIN, world.account, 'ABUSE', CODE), true);
    const ended = sub(world);
    assert.equal(ended.status, 'EXPIRED');
    assert.equal(ended.currentPeriodEnd.getTime(), NOW.getTime());
    assert.equal(ended.cancelAtPeriodEnd, true);
    assert.equal(resolveAccess(ended, NOW, SETTINGS.graceDays).access, 'blocked');
    assert.equal(await world.service.end(ADMIN, world.account, 'ABUSE', CODE), false);
    assert.deepEqual(
      world.audit.events.map((event) => event.action),
      ['SUBSCRIPTION_ENDED'],
    );
  });

  it('trilha que falha: a assinatura não muda; o log não traz e-mail nem código', async () => {
    const world = setup();
    world.uow.failAudit = true;
    const before = sub(world);
    await assert.rejects(world.service.extend(ADMIN, world.account, 5, 'OTHER'));
    await assert.rejects(world.service.end(ADMIN, world.account, 'OTHER', '987654'));
    assert.deepEqual(sub(world), before);
    assert.ok(!world.logs.raw().includes('987654'));
  });
});
