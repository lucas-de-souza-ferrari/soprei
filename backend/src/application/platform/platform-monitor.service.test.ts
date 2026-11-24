import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  CompanyId,
  PlatformAdminId,
  resolveAccess,
  type SubscriptionRecord,
  type SubscriptionStatus,
} from '../../domain/index.js';
import { NotFoundError } from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import {
  FakePlatformReadModel,
  InMemoryPlatformAuditRepository,
  InMemoryPlatformCompanyUnitOfWork,
} from '../../test-support/in-memory-platform.js';
import { captureLogs, logContains } from '../../test-support/log-capture.js';
import type { PlatformIdentity } from '../auth/identity.js';
import type { PlatformProcessCounters } from '../ports/platform-health.js';
import type {
  PlatformCompanyDetailFacts,
  PlatformSubscriptionGroup,
} from '../ports/platform-read-model.js';
import {
  brasiliaMonthStart,
  groupAccess,
  type PlatformHealthSources,
  PlatformMonitorService,
} from './platform-monitor.service.js';

const NOW = new Date('2026-11-24T12:00:00.000Z');
const DAY = 86_400_000;
const BILLING = { graceDays: 5, trialTokens: 600_000, trialReplies: 100 };
const ADMIN: PlatformIdentity = {
  kind: 'platform',
  adminId: PlatformAdminId.parse(randomUUID()),
  sessionId: 's1',
};
const COUNTERS: PlatformProcessCounters = {
  attendanceFallbacks: 0,
  attendanceUnsentReplies: 0,
  channelSend: { ok: 0, error: 0 },
  queueJobsFailed: 0,
  processFatalErrors: 0,
  entitlementErrors: 0,
  usageMeterErrors: 0,
  billingNoticesFailed: 0,
  salesContactRequests: {
    sent: 0,
    failed: 0,
    spam: 0,
    too_fast: 0,
    capped: 0,
    daily_cap: 0,
    invalid: 0,
    expired: 0,
  },
};

const UP: PlatformHealthSources = {
  database: () => Promise.resolve(Result.ok(undefined)),
  redis: () => Promise.resolve(Result.ok(undefined)),
  counters: () => Promise.resolve(COUNTERS),
  bootedAt: new Date('2026-11-24T10:00:00.000Z'),
};

function setup(
  options: {
    reads?: FakePlatformReadModel;
    billing?: boolean;
    health?: Partial<PlatformHealthSources>;
    onboarding?: { persona: boolean };
  } = {},
) {
  const logs = captureLogs();
  const audit = new InMemoryPlatformAuditRepository();
  const companies = new InMemoryPlatformCompanyUnitOfWork(audit);
  const reads = options.reads ?? new FakePlatformReadModel();
  const actions: string[] = [];
  const service = new PlatformMonitorService({
    reads,
    onboarding: {
      read: () =>
        Promise.resolve({
          dismissed: false,
          persona: options.onboarding?.persona ?? false,
          knowledge: true,
          schedule: false,
          inventory: true,
        }),
    },
    companies,
    audit,
    billing: options.billing === false ? undefined : BILLING,
    health: { ...UP, ...options.health },
    logger: logs.logger,
    metrics: { countPlatformAction: (action) => actions.push(action) },
    now: () => NOW,
  });
  return { service, reads, audit, companies, logs, actions };
}

function subscriptionRecord(overrides: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    id: randomUUID(),
    accountId: randomUUID(),
    plan: {
      id: randomUUID(),
      code: 'PROFESSIONAL',
      name: 'Profissional',
      maxCompanies: 3,
      monthlyTokens: 1_000_000,
      monthlyReplies: 1_000,
      metaEstimateMilliCents: 0,
      version: 1,
    },
    price: {
      id: randomUUID(),
      cycle: 'MONTHLY',
      baseCents: 10_000,
      agendaCents: 0,
      stockCents: 0,
      whatsappBillingMode: 'CUSTOMER_PAYS_META',
      metaPerReplyMilliCents: 0,
      extraPackCents: 0,
      extraPackReplies: 0,
      version: 1,
      validFrom: new Date('2026-01-01T00:00:00.000Z'),
    },
    cycle: 'MONTHLY',
    agendaEnabled: true,
    stockEnabled: false,
    status: 'ACTIVE',
    currentPeriodStart: new Date('2026-11-10T00:00:00.000Z'),
    currentPeriodEnd: new Date('2026-12-10T00:00:00.000Z'),
    trialEndsAt: null,
    cancelAtPeriodEnd: false,
    pendingChange: null,
    ...overrides,
  };
}

function companyFacts(id: CompanyId, overrides: Partial<PlatformCompanyDetailFacts> = {}) {
  const attendance = {
    activeConversations: 1,
    contactMessages: 2,
    replies: 2,
    fallbacks: 0,
    uncertainDeliveries: 0,
    handoffs: { CONTACT_REQUESTED: 0, CANNOT_HELP: 0, COMPLAINT: 0, SENSITIVE: 0, OTHER: 0 },
  };
  const facts: PlatformCompanyDetailFacts = {
    company: {
      id,
      name: 'Empresa A',
      slug: 'empresa-a',
      status: 'ACTIVE',
      createdAt: new Date('2026-11-01T00:00:00.000Z'),
      updatedAt: new Date('2026-11-02T00:00:00.000Z'),
    },
    subscriptionId: randomUUID(),
    memberships: [{ role: 'OWNER', status: 'ACTIVE', count: 1 }],
    holder: {
      accountId: randomUUID(),
      emailVerified: true,
      status: 'ACTIVE',
      createdAt: new Date('2026-11-01T00:00:00.000Z'),
    },
    channel: {
      state: 'CONNECTED',
      mode: 'API_ONLY',
      phoneNumberId: '106540352242922',
      wabaId: '102290129340398',
      connectedAt: new Date('2026-11-01T00:00:00.000Z'),
      tokenExpiresAt: new Date(NOW.getTime() + 3 * DAY),
      tokenInvalidAt: null,
    },
    attendance: { last24h: attendance, last7d: attendance, last30d: attendance },
    attention: { stalledPending: 0, unsentReplies: 0, openHandoffs: 1 },
    content: { documents: 2, activeProducts: 3, upcomingAppointments: 4 },
    ...overrides,
  };
  return facts;
}

describe('PlatformMonitorService (spec 044, E2)', () => {
  it('groupAccess aplica resolveAccess: o mesmo estado e acesso que as datas reais dariam', () => {
    const statuses: SubscriptionStatus[] = ['TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED'];
    const offsets = [-10 * DAY, -3 * DAY, -1, 1, 3 * DAY];
    for (const status of statuses) {
      for (const cancelAtPeriodEnd of [false, true]) {
        for (const periodOffset of offsets) {
          for (const trialOffset of [...offsets, null]) {
            const currentPeriodEnd = new Date(NOW.getTime() + periodOffset);
            const trialEndsAt = trialOffset === null ? null : new Date(NOW.getTime() + trialOffset);
            const real = resolveAccess(
              { status, cancelAtPeriodEnd, currentPeriodEnd, trialEndsAt },
              NOW,
              BILLING.graceDays,
            );
            const t = NOW.getTime();
            const group = {
              status,
              cancelAtPeriodEnd,
              trialOpen: t < (trialEndsAt ?? currentPeriodEnd).getTime(),
              periodOpen: t < currentPeriodEnd.getTime(),
              graceOpen: t < currentPeriodEnd.getTime() + BILLING.graceDays * DAY,
            };
            assert.deepEqual(
              groupAccess(group, NOW, BILLING.graceDays),
              real,
              JSON.stringify({ status, cancelAtPeriodEnd, periodOffset, trialOffset }),
            );
          }
        }
      }
    }
  });

  it('brasiliaMonthStart: o mês corrente começa à meia-noite de Brasília (03:00 UTC)', () => {
    assert.equal(
      brasiliaMonthStart(new Date('2026-11-24T12:00:00.000Z')).toISOString(),
      '2026-11-01T03:00:00.000Z',
    );
    // 1º de dezembro às 01:00 em Brasília ainda é... dezembro; às 02:00 UTC do dia 1º ainda é novembro.
    assert.equal(
      brasiliaMonthStart(new Date('2026-12-01T02:00:00.000Z')).toISOString(),
      '2026-11-01T03:00:00.000Z',
    );
    assert.equal(
      brasiliaMonthStart(new Date('2026-12-01T03:00:00.000Z')).toISOString(),
      '2026-12-01T03:00:00.000Z',
    );
  });

  it('overview com cobrança: assinaturas por estado efetivo, plano e acesso; pedidos pagos do mês', async () => {
    const group = (over: Partial<PlatformSubscriptionGroup>): PlatformSubscriptionGroup => ({
      status: 'ACTIVE',
      cancelAtPeriodEnd: false,
      planCode: 'ESSENTIAL',
      trialOpen: true,
      periodOpen: true,
      graceOpen: true,
      count: 1,
      ...over,
    });
    const reads = new FakePlatformReadModel({
      billingOverview: () =>
        Promise.resolve({
          subscriptions: [
            group({ status: 'TRIAL', count: 2 }),
            group({ status: 'TRIAL', trialOpen: false, count: 1 }),
            group({ periodOpen: false, planCode: 'SCALE', count: 3 }),
            group({ periodOpen: false, graceOpen: false, count: 4 }),
            group({ cancelAtPeriodEnd: true, planCode: 'PROFESSIONAL', count: 5 }),
          ],
          paidOrders: { count: 2, amountCents: 30_000 },
        }),
    });
    const { service } = setup({ reads });
    const overview = await service.overview();
    assert.deepEqual(overview.subscriptions, {
      byState: { TRIAL: 2, ACTIVE: 0, PAST_DUE: 3, CANCELLED: 5, EXPIRED: 5 },
      byPlan: { ESSENTIAL: 7, PROFESSIONAL: 5, SCALE: 3 },
      byAccess: { ok: 7, grace: 3, blocked: 5 },
    });
    assert.deepEqual(overview.paidOrdersThisMonth, {
      monthStart: new Date('2026-11-01T03:00:00.000Z'),
      count: 2,
      amountCents: 30_000,
    });
    const call = reads.calls.find((entry) => entry.method === 'billingOverview');
    assert.deepEqual(call?.args, [NOW, 5, new Date('2026-11-01T03:00:00.000Z')]);
  });

  it('cobrança desligada: assinaturas, pedidos, plano, acesso e uso vêm null e a leitura da cobrança nem roda', async () => {
    const id = CompanyId.parse(randomUUID());
    const reads = new FakePlatformReadModel({
      companyDetail: () => Promise.resolve(companyFacts(id)),
      listCompanies: () =>
        Promise.resolve({
          items: [
            {
              id,
              name: 'A',
              slug: 'a',
              status: 'ACTIVE',
              createdAt: NOW,
              lastActivityAt: null,
              channelState: 'NOT_CONNECTED',
              activeMembers: 1,
              messages7d: 0,
              subscription: {
                planCode: 'ESSENTIAL',
                status: 'TRIAL',
                currentPeriodEnd: new Date(NOW.getTime() + DAY),
                trialEndsAt: null,
                cancelAtPeriodEnd: false,
              },
            },
          ],
          nextCursor: null,
        }),
    });
    const { service } = setup({ reads, billing: false });
    const overview = await service.overview();
    assert.equal(overview.subscriptions, null);
    assert.equal(overview.paidOrdersThisMonth, null);
    const list = await service.listCompanies({}, { limit: 30 });
    assert.equal(list.items[0]?.plan, null);
    assert.equal(list.items[0].access, null);
    const detail = await service.companyDetail(id);
    assert.equal(detail.subscription, null);
    assert.equal(detail.usage, null);
    assert.deepEqual(detail.modules, { schedule: true, inventory: true });
    assert.deepEqual(await service.listOrders({}, { limit: 30 }), {
      billingEnabled: false,
      items: [],
      nextCursor: null,
    });
    assert.deepEqual(await service.listNotices({}, { limit: 30 }), {
      billingEnabled: false,
      items: [],
      nextCursor: null,
    });
    assert.ok(
      !reads.calls.some((call) =>
        ['billingOverview', 'subscription', 'listOrders', 'listNotices'].includes(call.method),
      ),
    );
  });

  it('lista de empresas com cobrança: plano e acesso efetivo pela regra do domínio', async () => {
    const reads = new FakePlatformReadModel({
      listCompanies: () =>
        Promise.resolve({
          items: [
            {
              id: CompanyId.parse(randomUUID()),
              name: 'A',
              slug: 'a',
              status: 'SUSPENDED',
              createdAt: NOW,
              lastActivityAt: NOW,
              channelState: 'LEGACY',
              activeMembers: 2,
              messages7d: 9,
              subscription: {
                planCode: 'SCALE',
                status: 'ACTIVE',
                currentPeriodEnd: new Date(NOW.getTime() - DAY),
                trialEndsAt: null,
                cancelAtPeriodEnd: false,
              },
            },
          ],
          nextCursor: 'c',
        }),
    });
    const { service } = setup({ reads });
    const page = await service.listCompanies({ status: 'SUSPENDED', q: 'a' }, { limit: 10 });
    assert.equal(page.items[0]?.plan, 'SCALE');
    assert.equal(page.items[0].access, 'grace');
    assert.equal(page.nextCursor, 'c');
    assert.deepEqual(reads.calls[0]?.args.slice(0, 2), [
      { status: 'SUSPENDED', q: 'a' },
      { limit: 10 },
    ]);
  });

  it('detalhe da empresa: hasPersona booleano, assinatura e uso com cotas, atenção do token; id malformado ou ausente é 404', async () => {
    const id = CompanyId.parse(randomUUID());
    const record = subscriptionRecord();
    const reads = new FakePlatformReadModel({
      companyDetail: (companyId) => Promise.resolve(companyId === id ? companyFacts(id) : null),
      subscription: () =>
        Promise.resolve({
          record,
          windowStart: record.currentPeriodStart,
          usage: { tokens: 5_000, sentMessages: 12, extraReplies: 10 },
        }),
    });
    const { service } = setup({ reads, onboarding: { persona: true } });
    const detail = await service.companyDetail(id);
    assert.equal(detail.hasPersona, true);
    assert.equal('persona' in detail, false);
    assert.deepEqual(detail.onboarding.steps, {
      persona: true,
      knowledge: true,
      schedule: false,
      inventory: true,
    });
    assert.deepEqual(detail.modules, { schedule: true, inventory: false });
    assert.equal(detail.subscription?.state, 'ACTIVE');
    assert.equal(detail.subscription.access, 'ok');
    assert.deepEqual(detail.usage, {
      windowStart: record.currentPeriodStart,
      windowEnd: new Date('2026-12-10T00:00:00.000Z'),
      replies: { used: 12, limit: 1_010 },
      tokens: { used: 5_000, limit: 1_000_000 + 10 * 8_000 },
    });
    assert.equal(detail.attention.tokenExpiringSoon, true);
    assert.equal(detail.attention.tokenInvalid, false);
    assert.equal(detail.attention.openHandoffs, 1);

    const before = reads.calls.length;
    await assert.rejects(service.companyDetail('nao-uuid'), NotFoundError);
    assert.equal(reads.calls.length, before, 'id malformado nem chega ao banco');
    await assert.rejects(service.companyDetail(randomUUID()), NotFoundError);
  });

  it('detalhe da conta: grava ACCOUNT_EMAIL_VIEWED com o admin e a conta (e a métrica); ausente é 404 sem gravar', async () => {
    const accountId = randomUUID();
    const reads = new FakePlatformReadModel({
      accountDetail: (id) =>
        Promise.resolve(
          id === accountId
            ? {
                id: accountId,
                email: 'lucia@exemplo.com',
                status: 'ACTIVE',
                verified: true,
                createdAt: NOW,
                companies: [],
              }
            : null,
        ),
    });
    const { service, audit, actions, logs } = setup({ reads });
    const detail = await service.accountDetail(ADMIN, accountId);
    assert.equal(detail.email, 'lucia@exemplo.com');
    assert.equal(detail.subscription, null);
    assert.equal(audit.events.length, 1);
    assert.equal(audit.events[0]?.action, 'ACCOUNT_EMAIL_VIEWED');
    assert.equal(audit.events[0].adminId, ADMIN.adminId);
    assert.equal(audit.events[0].subjectAccountId, accountId);
    assert.deepEqual(actions, ['account_email_viewed']);
    assert.ok(!logContains(logs.raw(), 'lucia@exemplo.com'));

    await assert.rejects(service.accountDetail(ADMIN, randomUUID()), NotFoundError);
    await assert.rejects(service.accountDetail(ADMIN, 'x'), NotFoundError);
    assert.equal(audit.events.length, 1);
    const list = await service.listAccounts({}, { limit: 30 });
    assert.deepEqual(list.items, []);
    assert.equal(audit.events.length, 1, 'a lista não grava nada');
  });

  it('suspender e reativar: estado e evento com o motivo; repetir não grava outro; concorrência grava um só', async () => {
    const { service, companies, audit, actions } = setup();
    const id = CompanyId.parse(randomUUID());
    companies.statuses.set(id, 'ACTIVE');

    assert.equal(await service.setCompanyStatus(ADMIN, id, 'SUSPENDED', 'PAYMENT'), true);
    assert.equal(companies.statuses.get(id), 'SUSPENDED');
    assert.equal(await service.setCompanyStatus(ADMIN, id, 'SUSPENDED', 'ABUSE'), false);
    assert.equal(audit.events.length, 1);
    assert.deepEqual(
      {
        action: audit.events[0]?.action,
        reason: audit.events[0]?.reason,
        subjectCompanyId: audit.events[0]?.subjectCompanyId,
      },
      { action: 'COMPANY_SUSPENDED', reason: 'PAYMENT', subjectCompanyId: id },
    );

    const results = await Promise.all([
      service.setCompanyStatus(ADMIN, id, 'ACTIVE', 'OWNER_REQUEST'),
      service.setCompanyStatus(ADMIN, id, 'ACTIVE', 'OTHER'),
    ]);
    assert.deepEqual(
      results.sort((a, b) => Number(a) - Number(b)),
      [false, true],
    );
    assert.equal(companies.statuses.get(id), 'ACTIVE');
    assert.equal(audit.events.length, 2);
    assert.equal(audit.events[1]?.action, 'COMPANY_REACTIVATED');
    assert.deepEqual(actions, ['company_suspended', 'company_reactivated']);

    await assert.rejects(
      service.setCompanyStatus(ADMIN, randomUUID(), 'SUSPENDED', 'OTHER'),
      NotFoundError,
    );
    await assert.rejects(
      service.setCompanyStatus(ADMIN, 'abc', 'SUSPENDED', 'OTHER'),
      NotFoundError,
    );
    assert.equal(audit.events.length, 2);
  });

  it('saúde: banco e Redis, fila desligada, inalcançável ou com contagens, retomada desligada, sem execução ou com a última', async () => {
    const disabled = await setup().service.health();
    assert.equal(disabled.database, 'up');
    assert.deepEqual(disabled.queue, { state: 'disabled' });
    assert.deepEqual(disabled.resume, { state: 'disabled' });
    assert.deepEqual(disabled.counters, COUNTERS);
    assert.equal(disabled.bootedAt.toISOString(), '2026-11-24T10:00:00.000Z');

    const run = {
      at: NOW,
      resume: { ok: true, scheduled: 1, skippedLimit: 0, failed: 0 },
      clean: { ok: false, completed: 0, failed: 0 },
    };
    const ok = await setup({
      health: {
        database: () => Promise.resolve(Result.err(new Error('fora'))),
        queue: { jobCounts: () => Promise.resolve({ waiting: 2, active: 1, failed: 0 }) },
        resumer: { lastRun: () => run },
      },
    }).service.health();
    assert.equal(ok.database, 'down');
    assert.deepEqual(ok.queue, { state: 'ok', jobs: { waiting: 2, active: 1, failed: 0 } });
    assert.deepEqual(ok.resume, { state: 'ran', ...run });

    const notRun = await setup({
      health: {
        queue: { jobCounts: () => Promise.reject(new Error('redis fora')) },
        resumer: { lastRun: () => null },
      },
    }).service.health();
    assert.deepEqual(notRun.queue, { state: 'unavailable' });
    assert.deepEqual(notRun.resume, { state: 'not_run' });

    // Fila que não responde: em ~1 s vira `unavailable` e o resto da resposta sai.
    const started = Date.now();
    const hanging = await setup({
      health: { queue: { jobCounts: () => new Promise<Record<string, number>>(() => undefined) } },
    }).service.health();
    assert.deepEqual(hanging.queue, { state: 'unavailable' });
    assert.ok(Date.now() - started < 5_000);
  });
});
