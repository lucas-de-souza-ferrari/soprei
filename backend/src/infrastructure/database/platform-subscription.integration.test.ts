import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { PlatformIdentity } from '../../application/auth/identity.js';
import { PlatformSubscriptionService } from '../../application/platform/platform-subscription.service.js';
import type { PlatformSubscriptionUnitOfWork } from '../../application/ports/platform-subscription-unit-of-work.js';
import {
  type CompanyId,
  PlatformAdminId,
  addMonthsUtc,
  priceTotalCents,
  quotaBlockReason,
  subscriptionFingerprint,
} from '../../domain/index.js';
import { ConflictError } from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import { createDatabase, type Database } from './database.js';
import { PrismaAccountRepository } from './repositories/account.repository.js';
import { PrismaBillingRepository } from './repositories/billing.repository.js';
import { PrismaCheckoutRepository } from './repositories/checkout.repository.js';
import { PrismaEntitlementReader } from './repositories/entitlement-reader.js';
import { PrismaPlatformSubscriptionUnitOfWork } from './repositories/platform-subscription-unit-of-work.js';

// Spec 045, E4: as ações do admin da plataforma sobre a assinatura com o Postgres real (soprei_test). O
// código do autenticador é um dublê que aceita só `CODE` (o TOTP real está nos testes de rota da E2/E3a).

const config = loadIntegrationConfig();
const DAY = 86_400_000;
const GRACE = 5;
const SETTINGS = { graceDays: GRACE, trialDays: 7, trialTokens: 300_000, trialReplies: 100 };
const CODE = '123456';

let database: Database;
let tenants: TestTenants;
let accounts: PrismaAccountRepository;
let billing: PrismaBillingRepository;
let admin: PlatformIdentity;
const logs = captureLogs();
const accountIds: string[] = [];
const createdAdmins: string[] = [];

const db = () => database.prisma;

function service(
  options: { billing?: boolean; unitOfWork?: PlatformSubscriptionUnitOfWork } = {},
): PlatformSubscriptionService {
  return new PlatformSubscriptionService({
    subscriptions: options.unitOfWork ?? new PrismaPlatformSubscriptionUnitOfWork(db()),
    confirmer: {
      confirmPlatformCode: (_id, code) =>
        Promise.resolve(
          code === CODE ? Result.ok(undefined) : Result.err({ reason: 'invalid_credentials' }),
        ),
    },
    settings: options.billing === false ? undefined : { graceDays: GRACE, trialDays: 7 },
    logger: logs.logger,
  });
}

async function newAccount(label: string): Promise<string> {
  const row = await db().account.create({
    data: {
      email: `e4-${label}-${randomBytes(6).toString('hex')}@exemplo.test`,
      passwordHash: 'x',
      emailVerifiedAt: new Date(),
    },
  });
  accountIds.push(row.id);
  return row.id;
}

async function companyFor(accountId: string): Promise<CompanyId> {
  const now = new Date();
  const result = await accounts.createCompany(accountId, 'Empresa E4', {
    now,
    trialDays: SETTINGS.trialDays,
    graceDays: GRACE,
  });
  tenants.track(result.companyId);
  return result.companyId;
}

/** Conta com assinatura paga ativa no plano pedido (a partir do teste criado pela primeira empresa). */
async function paidAccount(label: string, planCode: 'ESSENTIAL' | 'PROFESSIONAL' | 'SCALE') {
  const accountId = await newAccount(label);
  const companyId = await companyFor(accountId);
  const entry = (await billing.catalog(new Date(), false)).find((e) => e.plan.code === planCode);
  const price = entry?.prices.find((p) => p.cycle === 'MONTHLY');
  assert.ok(entry && price);
  const now = new Date();
  await db().subscription.updateMany({
    where: { accountId },
    data: {
      planId: entry.plan.id,
      priceId: price.id,
      status: 'ACTIVE',
      trialEndsAt: null,
      agendaEnabled: false,
      stockEnabled: false,
      currentPeriodStart: new Date(now.getTime() - 10 * DAY),
      currentPeriodEnd: new Date(now.getTime() + 20 * DAY),
    },
  });
  const sub = await billing.findSubscription(accountId);
  assert.ok(sub);
  return { accountId, companyId, sub };
}

const reader = () => new PrismaEntitlementReader(db(), SETTINGS);

async function events(accountId: string) {
  return db().platformAuditEvent.findMany({
    where: { subjectAccountId: accountId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      action: true,
      days: true,
      planCode: true,
      moduleSchedule: true,
      moduleInventory: true,
      reason: true,
    },
  });
}

const conflict = (code: string) => (error: unknown) =>
  error instanceof ConflictError && error.code === code;

before(async () => {
  database = createDatabase(config, logs.logger);
  tenants = new TestTenants(database.prisma);
  accounts = new PrismaAccountRepository(database.prisma);
  billing = new PrismaBillingRepository(database.prisma);
  const row = await db().platformAdmin.create({
    data: { email: `adm-e4-${randomUUID()}@exemplo.test`, passwordHash: 'x' },
  });
  createdAdmins.push(row.id);
  admin = { kind: 'platform', adminId: PlatformAdminId.parse(row.id), sessionId: randomUUID() };
});

after(async () => {
  try {
    await db().platformAuditEvent.deleteMany({ where: { adminId: { in: createdAdmins } } });
    await tenants.cleanup();
    const rows = await db().subscription.findMany({
      where: { accountId: { in: accountIds } },
      select: { id: true },
    });
    const ids = rows.map((row) => row.id);
    await db().usageCounter.deleteMany({ where: { subscriptionId: { in: ids } } });
    await db().paymentNotice.deleteMany({ where: { subscriptionId: { in: ids } } });
    await db().paymentOrder.deleteMany({ where: { subscriptionId: { in: ids } } });
    await db().subscription.deleteMany({ where: { id: { in: ids } } });
    await db().account.deleteMany({ where: { id: { in: accountIds } } });
    await db().platformAdmin.deleteMany({ where: { id: { in: createdAdmins } } });
  } finally {
    await database.close();
  }
});

describe('ações do admin sobre a assinatura com o Postgres real (spec 045, E4)', () => {
  it('cobrança desligada = 409 BILLING_DISABLED sem efeito', async () => {
    const { accountId, sub } = await paidAccount('off', 'PROFESSIONAL');
    await assert.rejects(
      service({ billing: false }).extend(admin, accountId, 10, 'OTHER'),
      conflict('BILLING_DISABLED'),
    );
    const after = await billing.findSubscription(accountId);
    assert.equal(after?.currentPeriodEnd.getTime(), sub.currentPeriodEnd.getTime());
    assert.deepEqual(await events(accountId), []);
  });

  it('conceder dias numa vencida além da carência devolve access ok até o novo fim; o uso já contado não zera; no teste estende o teste', async () => {
    const { accountId, companyId, sub } = await paidAccount('extend', 'PROFESSIONAL');
    // Vencida há 8 dias (carência de 5): bloqueada.
    const end = new Date(Date.now() - 8 * DAY);
    await db().subscription.updateMany({
      where: { id: sub.id },
      data: { currentPeriodEnd: end, status: 'PAST_DUE' },
    });
    await db().usageCounter.create({
      data: {
        subscriptionId: sub.id,
        windowStart: sub.currentPeriodStart,
        tokens: 4_321n,
        sentMessages: 7n,
      },
    });
    assert.equal((await reader().forCompany(companyId)).access, 'blocked');
    await service().extend(admin, accountId, 30, 'PAYMENT');
    const entitlements = await reader().forCompany(companyId);
    assert.equal(entitlements.access, 'ok');
    const extended = await billing.findSubscription(accountId);
    assert.ok(extended);
    assert.equal(extended.status, 'ACTIVE');
    assert.ok(extended.currentPeriodEnd.getTime() > Date.now() + 29 * DAY);
    // O início do período não mudou e a janela é a mesma: o uso contado continua lá.
    assert.equal(extended.currentPeriodStart.getTime(), sub.currentPeriodStart.getTime());
    assert.equal((await billing.usage(accountId, sub.currentPeriodStart)).tokens, 4_321);
    assert.deepEqual(await events(accountId), [
      {
        action: 'SUBSCRIPTION_EXTENDED',
        days: 30,
        planCode: null,
        moduleSchedule: null,
        moduleInventory: null,
        reason: 'PAYMENT',
      },
    ]);

    const trialAccount = await newAccount('trial-extend');
    const trialCompany = await companyFor(trialAccount);
    const trial = await billing.findSubscription(trialAccount);
    assert.ok(trial?.trialEndsAt);
    assert.equal(trial.status, 'TRIAL');
    await service().extend(admin, trialAccount, 10, 'OTHER');
    const longer = await billing.findSubscription(trialAccount);
    assert.ok(longer?.trialEndsAt);
    assert.equal(longer.status, 'TRIAL');
    assert.equal(longer.trialEndsAt.getTime(), trial.trialEndsAt.getTime() + 10 * DAY);
    assert.equal((await reader().forCompany(trialCompany)).access, 'ok');
  });

  it('liberar a Agenda vale na hora para a empresa da conta e entra no preço da renovação', async () => {
    const { accountId, companyId, sub } = await paidAccount('modules', 'PROFESSIONAL');
    assert.equal((await reader().forCompany(companyId)).agenda, false);
    await service().setModules(admin, accountId, { agenda: true, stock: false }, 'OWNER_REQUEST');
    const entitlements = await reader().forCompany(companyId);
    assert.equal(entitlements.agenda, true);
    assert.equal(entitlements.stock, false);
    const after = await billing.findSubscription(accountId);
    assert.ok(after);
    // A renovação usa o plano, o ciclo e os módulos atuais: passa a cobrar a Agenda.
    assert.equal(
      priceTotalCents(after.price, { agenda: after.agendaEnabled, stock: after.stockEnabled }),
      priceTotalCents(sub.price, { agenda: false, stock: false }) + sub.price.agendaCents,
    );
    const [event] = await events(accountId);
    assert.deepEqual(
      [event?.action, event?.moduleSchedule, event?.moduleInventory],
      ['SUBSCRIPTION_MODULES_CHANGED', true, false],
    );
  });

  it('trocar para um plano que não comporta as empresas = 409 PLAN_DOWNGRADE_BLOCKED; com pedido PENDING = 409 ORDER_PENDING; nada muda', async () => {
    const { accountId, sub } = await paidAccount('plan', 'PROFESSIONAL');
    await companyFor(accountId);
    await assert.rejects(
      service().changePlan(admin, accountId, 'ESSENTIAL', 'OTHER'),
      conflict('PLAN_DOWNGRADE_BLOCKED'),
    );
    await db().paymentOrder.create({
      data: {
        subscriptionId: sub.id,
        kind: 'RENEWAL',
        amountCents: 11_990,
        breakdown: { plan: 'PROFESSIONAL' },
        expiresAt: new Date(Date.now() + DAY),
      },
    });
    await assert.rejects(
      service().changePlan(admin, accountId, 'SCALE', 'OTHER'),
      conflict('ORDER_PENDING'),
    );
    assert.equal((await billing.findSubscription(accountId))?.plan.code, 'PROFESSIONAL');
    assert.deepEqual(await events(accountId), []);
  });

  it('trocar o plano comportado: vale na hora e apaga a troca agendada', async () => {
    const { accountId, sub } = await paidAccount('plan-ok', 'PROFESSIONAL');
    await db().subscription.updateMany({
      where: { id: sub.id },
      data: {
        pendingChange: { planCode: 'ESSENTIAL', cycle: 'MONTHLY', agenda: false, stock: false },
      },
    });
    await service().changePlan(admin, accountId, 'SCALE', 'OWNER_REQUEST');
    const after = await billing.findSubscription(accountId);
    assert.ok(after);
    assert.equal(after.plan.code, 'SCALE');
    assert.equal(after.pendingChange, null);
    assert.equal((await events(accountId))[0]?.planCode, 'SCALE');
  });

  it('encerrar agora: o atendimento da empresa fica bloqueado; a linha e os pedidos continuam no banco', async () => {
    const { accountId, companyId, sub } = await paidAccount('end', 'PROFESSIONAL');
    await db().paymentOrder.create({
      data: {
        subscriptionId: sub.id,
        kind: 'NEW',
        amountCents: 11_990,
        status: 'PAID',
        breakdown: { plan: 'PROFESSIONAL' },
        expiresAt: new Date(Date.now() - DAY),
      },
    });
    await assert.rejects(service().end(admin, accountId, 'ABUSE', '000000'));
    assert.equal((await reader().forCompany(companyId)).access, 'ok');
    await service().end(admin, accountId, 'ABUSE', CODE);
    const entitlements = await reader().forCompany(companyId);
    assert.equal(entitlements.access, 'blocked');
    // A mesma decisão que o atendimento toma antes de chamar o provedor (spec 031): bloqueada = não chama.
    assert.equal(quotaBlockReason(entitlements), 'inactive');
    assert.equal((await billing.findSubscription(accountId))?.status, 'EXPIRED');
    assert.equal(await db().paymentOrder.count({ where: { subscriptionId: sub.id } }), 1);
  });

  it('iniciar teste: conta com assinatura = 409 SUBSCRIPTION_EXISTS; conta sem assinatura ganha o teste e as empresas dela são adotadas', async () => {
    const { accountId } = await paidAccount('trial-exists', 'ESSENTIAL');
    await assert.rejects(
      service().startTrial(admin, accountId, 'OTHER'),
      conflict('SUBSCRIPTION_EXISTS'),
    );
    const fresh = await newAccount('trial-new');
    const company = await tenants.createCompany('e4-trial');
    await db().membership.create({
      data: {
        companyId: company.id,
        accountId: fresh,
        email: `dono-${randomUUID()}@exemplo.test`,
        passwordHash: 'account-managed',
        role: 'OWNER',
      },
    });
    await service().startTrial(admin, fresh, 'OWNER_REQUEST');
    const trial = await billing.findSubscription(fresh);
    assert.ok(trial);
    assert.equal(trial.status, 'TRIAL');
    const adopted = await db().company.findFirst({
      where: { id: company.id },
      select: { subscriptionId: true },
    });
    assert.equal(adopted?.subscriptionId, trial.id);
  });

  it('trilha que falha: a assinatura não muda (rollback real)', async () => {
    const { accountId, sub } = await paidAccount('fail', 'PROFESSIONAL');
    const real = new PrismaPlatformSubscriptionUnitOfWork(db());
    const broken: PlatformSubscriptionUnitOfWork = {
      run: (fn) =>
        real.run((tx) =>
          fn({ ...tx, audit: () => Promise.reject(new Error('trilha indisponível')) }),
        ),
    };
    await assert.rejects(service({ unitOfWork: broken }).extend(admin, accountId, 10, 'OTHER'));
    await assert.rejects(
      service({ unitOfWork: broken }).setModules(
        admin,
        accountId,
        { agenda: true, stock: true },
        'OTHER',
      ),
    );
    const after = await billing.findSubscription(accountId);
    assert.ok(after);
    assert.equal(after.currentPeriodEnd.getTime(), sub.currentPeriodEnd.getTime());
    assert.equal(after.agendaEnabled, false);
  });

  it('revisão B1: conceder dias e depois renovar pagando nunca perde os dias concedidos (fim novo >= fim concedido + 1 mês)', async () => {
    const { accountId, sub } = await paidAccount('renew', 'PROFESSIONAL');
    await service().extend(admin, accountId, 20, 'OTHER');
    const granted = await billing.findSubscription(accountId);
    assert.ok(granted);
    const order = await db().paymentOrder.create({
      data: {
        subscriptionId: sub.id,
        kind: 'RENEWAL',
        amountCents: sub.price.baseCents,
        breakdown: {
          planCode: 'PROFESSIONAL',
          cycle: 'MONTHLY',
          agenda: false,
          stock: false,
          priceId: sub.price.id,
          priceVersion: sub.price.version,
          whatsappBillingMode: sub.price.whatsappBillingMode,
        },
        expiresAt: new Date(Date.now() + DAY),
      },
    });
    const result = await new PrismaCheckoutRepository(db()).grantPaidOrder(
      order.id,
      { transactionNsu: null, slug: null, captureMethod: null },
      new Date(),
      GRACE,
    );
    assert.equal(result.granted, true, JSON.stringify(result));
    const renewed = await billing.findSubscription(accountId);
    assert.ok(renewed);
    assert.ok(
      renewed.currentPeriodEnd.getTime() >= addMonthsUtc(granted.currentPeriodEnd, 1).getTime(),
      'a renovação não encurta o período concedido',
    );
  });

  it('revisão I1: pedido EXPIRED com link (substituído, ainda pagável) também é ORDER_PENDING', async () => {
    const { accountId, sub } = await paidAccount('expired-link', 'PROFESSIONAL');
    await db().paymentOrder.create({
      data: {
        subscriptionId: sub.id,
        kind: 'RENEWAL',
        status: 'EXPIRED',
        amountCents: 11_990,
        breakdown: { plan: 'PROFESSIONAL' },
        checkoutUrl: 'https://checkout.infinitepay.io/teste/link',
        expiresAt: new Date(Date.now() + DAY),
      },
    });
    await assert.rejects(
      service().setModules(admin, accountId, { agenda: true, stock: false }, 'OTHER'),
      conflict('ORDER_PENDING'),
    );
  });

  it('revisão I2: o checkout não grava pedido se a assinatura mudou depois da avaliação (impressão digital)', async () => {
    const { accountId, sub } = await paidAccount('stale', 'PROFESSIONAL');
    const fingerprint = subscriptionFingerprint(sub);
    await service().setModules(admin, accountId, { agenda: true, stock: false }, 'OTHER');
    const checkout = new PrismaCheckoutRepository(db());
    const input = {
      id: randomUUID(),
      kind: 'RENEWAL' as const,
      amountCents: 11_990,
      breakdown: {
        planCode: 'PROFESSIONAL' as const,
        cycle: 'MONTHLY' as const,
        agenda: false,
        stock: false,
        priceId: sub.price.id,
        priceVersion: sub.price.version,
        whatsappBillingMode: sub.price.whatsappBillingMode,
      },
      expiresAt: new Date(Date.now() + DAY),
    };
    const cap = { since: new Date(Date.now() - DAY), max: 10 };
    assert.equal(await checkout.createPendingOrder(accountId, input, cap, fingerprint), 'stale');
    assert.equal(await db().paymentOrder.count({ where: { subscriptionId: sub.id } }), 0);
    const fresh = await billing.findSubscription(accountId);
    assert.ok(fresh);
    const created = await checkout.createPendingOrder(
      accountId,
      { ...input, id: randomUUID() },
      cap,
      subscriptionFingerprint(fresh),
    );
    assert.notEqual(created, 'stale');
  });

  it('revisão I3: teste gravado como EXPIRED (tarefa dos avisos) continua teste ao conceder dias', async () => {
    const accountId = await newAccount('trial-expired');
    const companyId = await companyFor(accountId);
    const past = new Date(Date.now() - 2 * DAY);
    await db().subscription.updateMany({
      where: { accountId },
      data: { status: 'EXPIRED', trialEndsAt: past, currentPeriodEnd: past },
    });
    await service().extend(admin, accountId, 5, 'OTHER');
    const after = await billing.findSubscription(accountId);
    assert.equal(after?.status, 'TRIAL');
    assert.equal((await reader().forCompany(companyId)).access, 'ok');
  });
});
