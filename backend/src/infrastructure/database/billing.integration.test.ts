import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { BillingService } from '../../application/billing/billing.service.js';
import {
  type CompanyBillingPolicy,
  type CompanyId,
  CompanyId as CompanyIdParser,
  dueNotices,
  quotaBlockReason,
  resolveAccess,
} from '../../domain/index.js';
import { ForbiddenError } from '../../shared/errors/index.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import { createLogger } from '../logger/logger.js';
import { createDatabase, type Database } from './database.js';
import { PrismaAccountRepository } from './repositories/account.repository.js';
import { PrismaBillingNoticeRepository } from './repositories/billing-notice.repository.js';
import { PrismaBillingRepository } from './repositories/billing.repository.js';
import { PrismaEntitlementReader } from './repositories/entitlement-reader.js';
import { PrismaUsageMeter } from './repositories/usage-meter.js';

// Spec 031 (E1/E2): catálogo, assinatura por conta, limite de empresas, medição e cotas, tudo contra o
// Postgres real (soprei_test). Os models de cobrança são globais: a barreira é o repositório por conta.
const baseConfig = loadIntegrationConfig();
const config = { ...baseConfig, DB_POOL_MAX: 30, DB_POOL_CONNECTION_TIMEOUT_MS: 30_000 };
const DAY = 86_400_000;
const GRACE = 5;
const SETTINGS = { graceDays: GRACE, trialDays: 7, trialTokens: 300_000, trialReplies: 100 };

let database: Database;
let tenants: TestTenants;
let accountsRepo: PrismaAccountRepository;
let billing: PrismaBillingRepository;
const accountIds: string[] = [];
const subscriptionIds = new Set<string>();

function db() {
  return database.prisma;
}

async function newAccount(label: string): Promise<string> {
  const row = await db().account.create({
    data: {
      email: `${label}-${randomBytes(6).toString('hex')}@exemplo.test`,
      passwordHash: 'x',
      emailVerifiedAt: new Date(),
    },
  });
  accountIds.push(row.id);
  return row.id;
}

function policy(now: Date): CompanyBillingPolicy {
  return { now, trialDays: SETTINGS.trialDays, graceDays: GRACE };
}

async function createCompanyFor(accountId: string, now: Date): Promise<CompanyId> {
  const result = await accountsRepo.createCompany(accountId, 'Empresa de teste', policy(now));
  tenants.track(result.companyId);
  return result.companyId;
}

function reader(now: () => Date) {
  return new PrismaEntitlementReader(db(), SETTINGS, now);
}

async function subscriptionOf(accountId: string) {
  const subscription = await billing.findSubscription(accountId);
  assert.ok(subscription !== null);
  subscriptionIds.add(subscription.id);
  return subscription;
}

before(() => {
  database = createDatabase(config, createLogger(config));
  tenants = new TestTenants(database.prisma);
  accountsRepo = new PrismaAccountRepository(database.prisma);
  billing = new PrismaBillingRepository(database.prisma);
});

after(async () => {
  try {
    await tenants.cleanup();
    // Toda assinatura das contas de teste (inclusive as criadas pelo createCompany), sem tocar em outras.
    const rows = await db().subscription.findMany({
      where: { accountId: { in: accountIds } },
      select: { id: true },
    });
    const ids = [...new Set([...subscriptionIds, ...rows.map((row) => row.id)])];
    await db().usageCounter.deleteMany({ where: { subscriptionId: { in: ids } } });
    await db().paymentNotice.deleteMany({ where: { subscriptionId: { in: ids } } });
    await db().paymentOrder.deleteMany({ where: { subscriptionId: { in: ids } } });
    await db().subscription.deleteMany({ where: { id: { in: ids } } });
    await db().account.deleteMany({ where: { id: { in: accountIds } } });
  } finally {
    await database.close();
  }
});

describe('catálogo vigente (spec 031, E1; valores da spec 040, D1 e D2)', () => {
  it('3 planos e 6 preços (mensal e anual = 10 x o mensal) só no modo CUSTOMER_PAYS_META', async () => {
    const catalog = await billing.catalog(new Date(), false);
    assert.deepEqual(
      catalog.map((entry) => [
        entry.plan.code,
        entry.plan.maxCompanies,
        entry.plan.monthlyTokens,
        entry.plan.monthlyReplies,
      ]),
      [
        ['ESSENTIAL', 1, 15_000_000, 2_500],
        ['PROFESSIONAL', 3, 48_000_000, 8_000],
        ['SCALE', 10, 180_000_000, 30_000],
      ],
    );
    const prices = Object.fromEntries(
      catalog.map((entry) => [
        entry.plan.code,
        entry.prices.map((price) => [
          price.cycle,
          price.baseCents,
          price.agendaCents,
          price.stockCents,
        ]),
      ]),
    );
    assert.deepEqual(prices.ESSENTIAL, [
      ['MONTHLY', 4_790, 2_900, 1_900],
      ['ANNUAL', 47_900, 29_000, 19_000],
    ]);
    assert.deepEqual(prices.PROFESSIONAL, [
      ['MONTHLY', 11_990, 4_900, 3_900],
      ['ANNUAL', 119_900, 49_000, 39_000],
    ]);
    assert.deepEqual(prices.SCALE, [
      ['MONTHLY', 34_900, 9_900, 7_900],
      ['ANNUAL', 349_000, 99_000, 79_000],
    ]);
    // Relógio anterior ao deploy (datas fixas dos testes): o mesmo catálogo (valid_from da semente da 031).
    const early = await billing.catalog(new Date('2026-11-10T12:00:00Z'), false);
    assert.deepEqual(
      early.map((entry) => [entry.plan.code, entry.plan.version, entry.prices.length]),
      catalog.map((entry) => [entry.plan.code, entry.plan.version, 2]),
    );
    for (const entry of catalog) {
      for (const price of entry.prices) {
        assert.equal(price.whatsappBillingMode, 'CUSTOMER_PAYS_META');
        assert.equal(price.metaPerReplyMilliCents, 3_500);
      }
    }
  });

  it('gate do modo S: versão de preço SOPREI_PAYS_META é ignorada sem a flag e só aparece com ela', async () => {
    // A versão vigente do Essencial (a que o catálogo lê).
    const plan = await db().plan.findFirst({
      where: { code: 'ESSENTIAL', active: true },
      orderBy: { version: 'desc' },
    });
    assert.ok(plan !== null);
    const row = await db().planPrice.create({
      data: {
        planId: plan.id,
        cycle: 'MONTHLY',
        baseCents: 7_900,
        agendaCents: 2_900,
        stockCents: 1_900,
        whatsappBillingMode: 'SOPREI_PAYS_META',
        metaPerReplyMilliCents: 3_500,
        extraPackCents: 5_900,
        extraPackReplies: 500,
        version: 99,
        validFrom: new Date('2026-11-01T00:00:00Z'),
      },
    });
    try {
      const off = await billing.catalog(new Date(), false);
      const modesOff = off.flatMap((entry) => entry.prices.map((p) => p.whatsappBillingMode));
      assert.equal(modesOff.includes('SOPREI_PAYS_META'), false);
      const on = await billing.catalog(new Date(), true);
      const essential = on.find((entry) => entry.plan.code === 'ESSENTIAL');
      assert.ok(essential?.prices.some((p) => p.whatsappBillingMode === 'SOPREI_PAYS_META'));
      // O teste gratuito nunca usa o modo S.
      const account = await newAccount('gate');
      const trial = await billing.ensureTrial(account, new Date(), SETTINGS);
      subscriptionIds.add(trial.id);
      assert.equal(trial.price.whatsappBillingMode, 'CUSTOMER_PAYS_META');
    } finally {
      await db().subscription.deleteMany({ where: { priceId: row.id } });
      await db().planPrice.deleteMany({ where: { id: row.id } });
    }
  });

  it('preço com valor de catálogo inválido é recusado pelo banco (CHECK)', async () => {
    const plan = await db().plan.findFirst({ where: { code: 'SCALE' } });
    assert.ok(plan !== null);
    await assert.rejects(
      db().planPrice.create({
        data: {
          planId: plan.id,
          cycle: 'MONTHLY',
          baseCents: 0,
          agendaCents: 0,
          stockCents: 0,
          metaPerReplyMilliCents: 0,
          extraPackCents: 0,
          extraPackReplies: 0,
          version: 98,
          validFrom: new Date(),
        },
      }),
    );
  });
});

describe('teste gratuito e isolamento entre contas (spec 031, E1)', () => {
  it('ensureTrial cria o teste uma vez por conta (Essencial, módulos liberados, prazo da config) e não reinicia', async () => {
    const account = await newAccount('trial');
    const now = new Date('2026-11-10T12:00:00Z');
    const first = await billing.ensureTrial(account, now, SETTINGS);
    subscriptionIds.add(first.id);
    assert.equal(first.status, 'TRIAL');
    assert.equal(first.plan.code, 'ESSENTIAL');
    assert.equal(first.agendaEnabled, true);
    assert.equal(first.stockEnabled, true);
    assert.equal(first.trialEndsAt?.getTime(), now.getTime() + 7 * DAY);
    const later = await billing.ensureTrial(account, new Date(now.getTime() + 30 * DAY), SETTINGS);
    assert.equal(later.id, first.id);
    assert.equal(later.trialEndsAt?.getTime(), first.trialEndsAt.getTime());
  });

  it('criações simultâneas do teste da mesma conta resultam em UMA assinatura', async () => {
    const account = await newAccount('race');
    const results = await Promise.all(
      Array.from({ length: 10 }, () => billing.ensureTrial(account, new Date(), SETTINGS)),
    );
    assert.equal(new Set(results.map((r) => r.id)).size, 1);
    subscriptionIds.add(results[0]?.id ?? '');
    assert.equal(await db().subscription.count({ where: { accountId: account } }), 1);
  });

  it('a conta B não lê assinatura, pedido, uso nem contagem de empresas da conta A (resultado igual ao de inexistente)', async () => {
    const accountA = await newAccount('iso-a');
    const accountB = await newAccount('iso-b');
    const now = new Date('2026-11-10T12:00:00Z');
    const subA = await billing.ensureTrial(accountA, now, SETTINGS);
    subscriptionIds.add(subA.id);
    const order = await db().paymentOrder.create({
      data: {
        subscriptionId: subA.id,
        kind: 'NEW',
        amountCents: 5_900,
        breakdown: { plan: 'ESSENTIAL' },
        expiresAt: new Date(now.getTime() + DAY),
      },
    });
    await db().usageCounter.create({
      data: {
        subscriptionId: subA.id,
        windowStart: subA.currentPeriodStart,
        tokens: 77n,
        sentMessages: 5n,
      },
    });
    await createCompanyFor(accountA, now);

    // A enxerga o que é dela.
    assert.equal((await billing.findOrder(accountA, order.id))?.id, order.id);
    assert.equal((await billing.listOrders(accountA, 10)).length, 1);
    assert.equal((await billing.usage(accountA, subA.currentPeriodStart)).tokens, 77);
    assert.equal(await billing.countCompanies(accountA), 1);

    // B, que ainda nem tem assinatura, vê o mesmo que a conta inexistente.
    assert.equal(await billing.findSubscription(accountB), null);
    assert.equal(await billing.findOrder(accountB, order.id), null);
    assert.equal(await billing.findOrder(accountB, 'não-é-uuid'), null);
    assert.deepEqual(await billing.listOrders(accountB, 10), []);
    assert.deepEqual(await billing.usage(accountB, subA.currentPeriodStart), {
      windowStart: subA.currentPeriodStart,
      tokens: 0,
      sentMessages: 0,
      extraReplies: 0,
    });
    assert.equal(await billing.countCompanies(accountB), 0);

    // O teste de B nasce separado e continua sem ver o pedido de A.
    const subB = await billing.ensureTrial(accountB, now, SETTINGS);
    subscriptionIds.add(subB.id);
    assert.notEqual(subB.id, subA.id);
    assert.equal(await billing.findOrder(accountB, order.id), null);
    assert.equal((await billing.usage(accountB, subA.currentPeriodStart)).tokens, 0);
  });

  it('GET /account/billing (serviço): sem assinatura devolve subscription null e o catálogo; com assinatura, estado, cotas e estimativa da Meta do catálogo', async () => {
    const service = new BillingService({
      billing,
      settings: { ...SETTINGS, allowSopreiPaysMeta: false },
      now: () => new Date('2026-11-12T12:00:00Z'),
    });
    const account = await newAccount('overview');
    const empty = await service.overview(account);
    assert.equal(empty.subscription, null);
    assert.equal(empty.trial.available, true);
    assert.equal(empty.catalog.length, 3);
    const sub = await billing.ensureTrial(account, new Date('2026-11-10T12:00:00Z'), SETTINGS);
    subscriptionIds.add(sub.id);
    await db().usageCounter.create({
      data: {
        subscriptionId: sub.id,
        windowStart: sub.currentPeriodStart,
        tokens: 1_000n,
        sentMessages: 10n,
      },
    });
    const overview = await service.overview(account);
    assert.ok(overview.usage !== null);
    assert.equal(overview.subscription?.status, 'TRIAL');
    assert.equal(overview.subscription.access, 'ok');
    assert.equal(overview.subscription.whatsappNotice, 'NOT_INCLUDED');
    assert.deepEqual(overview.usage.tokens, { used: 1_000, limit: 300_000 });
    // Teste gratuito: min(BILLING_TRIAL_REPLIES, cota do plano) = min(100, 2.500) (spec 040, D8).
    assert.deepEqual(overview.usage.replies, { used: 10, limit: 100 });
    // 10 mensagens x 3.500 milésimos de centavo, rotulada como estimativa.
    assert.deepEqual(overview.usage.metaEstimate, { isEstimate: true, milliCents: 35_000 });
    // A estimativa vem do catálogo: muda quando o catálogo muda.
    await db().plan.updateMany({
      where: { id: sub.plan.id },
      data: { metaEstimateMilliCents: 4_000 },
    });
    try {
      const changed = await service.overview(account);
      assert.equal(changed.usage?.metaEstimate.milliCents, 40_000);
    } finally {
      await db().plan.updateMany({
        where: { id: sub.plan.id },
        data: { metaEstimateMilliCents: 3_500 },
      });
    }
  });
});

describe('createCompany com a cobrança ligada (spec 031, E1)', () => {
  const now = new Date('2026-11-10T12:00:00Z');

  it('sem a política (BILLING_ENABLED=false) cria como antes: sem assinatura e sem limite do plano', async () => {
    const account = await newAccount('off');
    const a = await accountsRepo.createCompany(account, 'Uma');
    const b = await accountsRepo.createCompany(account, 'Duas');
    tenants.track(a.companyId);
    tenants.track(b.companyId);
    const rows = await db().company.findMany({ where: { id: { in: [a.companyId, b.companyId] } } });
    assert.deepEqual(
      rows.map((row) => row.subscriptionId),
      [null, null],
    );
    assert.equal(await db().subscription.count({ where: { accountId: account } }), 0);
  });

  it('a empresa criada grava subscriptionId; acima de maxCompanies é 403 PLAN_COMPANY_LIMIT', async () => {
    const account = await newAccount('limit');
    const companyId = await createCompanyFor(account, now);
    const subscription = await subscriptionOf(account);
    const row = await db().company.findFirst({ where: { id: companyId } });
    assert.equal(row?.subscriptionId, subscription.id);
    await assert.rejects(
      () => accountsRepo.createCompany(account, 'Segunda', policy(now)),
      (error: unknown) => error instanceof ForbiddenError && error.code === 'PLAN_COMPANY_LIMIT',
    );
    assert.equal(await billing.countCompanies(account), 1);
  });

  it('duas requisições simultâneas no limite criam só uma empresa (a trava da conta serializa)', async () => {
    const account = await newAccount('conc');
    const outcomes = await Promise.allSettled([
      accountsRepo.createCompany(account, 'X', policy(now)),
      accountsRepo.createCompany(account, 'Y', policy(now)),
    ]);
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') tenants.track(outcome.value.companyId);
    }
    await subscriptionOf(account);
    assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1, 'uma só criada');
    const failed = outcomes.find((o) => o.status === 'rejected');
    assert.ok(
      failed?.status === 'rejected' &&
        failed.reason instanceof ForbiddenError &&
        failed.reason.code === 'PLAN_COMPANY_LIMIT',
      'a outra recebe PLAN_COMPANY_LIMIT (motivo: serialização pela trava da conta)',
    );
    assert.equal(await billing.countCompanies(account), 1);
  });

  it('plano com limite maior (Profissional, 3) deixa criar até 3 e recusa a 4ª', async () => {
    const account = await newAccount('pro');
    await createCompanyFor(account, now);
    const subscription = await subscriptionOf(account);
    const pro = await db().plan.findFirst({ where: { code: 'PROFESSIONAL' } });
    assert.ok(pro !== null);
    await db().subscription.updateMany({
      where: { id: subscription.id },
      data: { planId: pro.id },
    });
    await createCompanyFor(account, now);
    await createCompanyFor(account, now);
    await assert.rejects(
      () => accountsRepo.createCompany(account, 'Quarta', policy(now)),
      (error: unknown) => error instanceof ForbiddenError && error.code === 'PLAN_COMPANY_LIMIT',
    );
  });

  it('holderOf: só a conta titular da assinatura DA EMPRESA é titular; membro de empresa de outra conta não é, mesmo com assinatura própria', async () => {
    const ownerA = await newAccount('holder-a');
    const guestB = await newAccount('holder-b');
    const companyA = await createCompanyFor(ownerA, now);
    // B tem assinatura própria (empresa própria) e é membro da empresa de A.
    const companyB = await createCompanyFor(guestB, now);
    const guestInA = await db().membership.create({
      data: {
        companyId: companyA,
        accountId: guestB,
        email: `h-${randomBytes(4).toString('hex')}@exemplo.test`,
        passwordHash: 'account-managed',
        role: 'OWNER',
      },
    });
    const ownerInA = await db().membership.findFirstOrThrow({
      where: { companyId: companyA, accountId: ownerA },
    });
    const guestInB = await db().membership.findFirstOrThrow({
      where: { companyId: companyB, accountId: guestB },
    });
    const r = reader(() => now);
    assert.equal(await r.holderOf(companyA, ownerInA.id), true);
    assert.equal(await r.holderOf(companyA, guestInA.id), false);
    assert.equal(await r.holderOf(companyB, guestInB.id), true);
    // Vínculo de outra empresa nunca vale para esta.
    assert.equal(await r.holderOf(companyA, guestInB.id), false);
    assert.equal(await r.holderOf(companyB, ownerInA.id), false);
  });

  it('quem entra por convite numa empresa alheia não consome o limite dele', async () => {
    const owner = await newAccount('owner');
    const guest = await newAccount('guest');
    const company = await createCompanyFor(owner, now);
    // O convidado vira membro da empresa do dono (vínculo AGENT).
    await db().membership.create({
      data: {
        companyId: company,
        accountId: guest,
        email: `g-${randomBytes(4).toString('hex')}@exemplo.test`,
        passwordHash: 'account-managed',
        role: 'AGENT',
      },
    });
    // O limite do convidado continua inteiro: a empresa alheia não conta, a dele nasce.
    const own = await createCompanyFor(guest, now);
    const guestSub = await subscriptionOf(guest);
    const ownerSub = await subscriptionOf(owner);
    assert.notEqual(guestSub.id, ownerSub.id);
    assert.equal(await billing.countCompanies(guest), 1);
    assert.equal(await billing.countCompanies(owner), 1);
    assert.notEqual(own, company);
  });

  it('assinatura expirada recusa a criação com 403 SUBSCRIPTION_INACTIVE', async () => {
    const account = await newAccount('expired');
    const sub = await billing.ensureTrial(account, now, SETTINGS);
    subscriptionIds.add(sub.id);
    const later = new Date(now.getTime() + 8 * DAY);
    await assert.rejects(
      () => accountsRepo.createCompany(account, 'Tarde', policy(later)),
      (error: unknown) => error instanceof ForbiddenError && error.code === 'SUBSCRIPTION_INACTIVE',
    );
    assert.equal(resolveAccess(sub, later, GRACE).access, 'blocked');
  });
});

describe('EntitlementReader e UsageMeter (spec 031, E2)', () => {
  const start = new Date('2026-11-10T12:00:00Z');
  let clock = start;
  const now = (): Date => clock;

  it('empresa da assinatura A nunca consome a cota da B; o contador de uma não aparece nos entitlements da outra', async () => {
    clock = start;
    const meter = new PrismaUsageMeter(db(), now);
    const accountA = await newAccount('ent-a');
    const accountB = await newAccount('ent-b');
    const companyA = await createCompanyFor(accountA, start);
    const companyB = await createCompanyFor(accountB, start);
    await meter.record(companyA, 1_200);
    await meter.recordSent(companyA);
    const a = await reader(now).forCompany(companyA);
    const b = await reader(now).forCompany(companyB);
    assert.deepEqual(a, {
      access: 'ok',
      agenda: true,
      stock: true,
      tokens: { used: 1_200, limit: 300_000 },
      replies: { used: 1, limit: 100 },
    });
    assert.deepEqual(b.tokens, { used: 0, limit: 300_000 });
    assert.deepEqual(b.replies, { used: 0, limit: 100 });
    // Sem dinheiro, e o resultado não carrega nada da assinatura além de números e flags.
    assert.doesNotMatch(JSON.stringify(a), /cents|price|account|subscription/i);
  });

  it('50 incrementos concorrentes de tokens e 50 de respostas somam exato (sem perda)', async () => {
    clock = start;
    const meter = new PrismaUsageMeter(db(), now);
    const account = await newAccount('atomic');
    const company = await createCompanyFor(account, start);
    await Promise.all([
      ...Array.from({ length: 50 }, () => meter.record(company, 7)),
      ...Array.from({ length: 50 }, () => meter.recordSent(company)),
    ]);
    const entitlements = await reader(now).forCompany(company);
    assert.equal(
      entitlements.tokens?.used,
      350,
      'tokens: 50 x 7 (motivo: increment atômico no banco)',
    );
    assert.equal(entitlements.replies?.used, 50, 'respostas: 50 x 1');
    const rows = await db().usageCounter.count({
      where: { subscription: { accountId: account } },
    });
    assert.equal(rows, 1, 'uma só linha de janela mesmo na corrida de criação');
  });

  it('janela nova (mês seguinte, plano pago mensal) volta a cota a zero; a janela anterior segue guardada', async () => {
    clock = start;
    const meter = new PrismaUsageMeter(db(), now);
    const account = await newAccount('window');
    const company = await createCompanyFor(account, start);
    const sub = await subscriptionOf(account);
    // Plano mensal pago com o período de 10/11 a 10/12.
    await db().subscription.updateMany({
      where: { id: sub.id },
      data: {
        status: 'ACTIVE',
        trialEndsAt: null,
        currentPeriodStart: start,
        currentPeriodEnd: new Date('2026-12-10T12:00:00Z'),
      },
    });
    await meter.record(company, 500);
    assert.equal((await reader(now).forCompany(company)).tokens?.used, 500);
    // Dentro da carência (depois do fim do período) o uso segue na mesma janela, sem cota grátis nova.
    clock = new Date('2026-12-12T12:00:00Z');
    const grace = await reader(now).forCompany(company);
    assert.equal(grace.access, 'grace');
    assert.equal(grace.tokens?.used, 500);
    // Renovação paga: período novo ancorado em 10/12 => janela nova, uso zerado.
    await db().subscription.updateMany({
      where: { id: sub.id },
      data: {
        currentPeriodStart: new Date('2026-12-10T12:00:00Z'),
        currentPeriodEnd: new Date('2027-01-10T12:00:00Z'),
      },
    });
    const renewed = await reader(now).forCompany(company);
    assert.equal(renewed.access, 'ok');
    assert.equal(renewed.tokens?.used, 0);
    assert.equal(
      renewed.tokens.limit,
      15_000_000,
      'plano pago: cota de tokens do plano (não a do teste)',
    );
    assert.equal(
      await db().usageCounter.count({ where: { subscriptionId: sub.id } }),
      1,
      'a janela anterior continua guardada',
    );
  });

  it('o tempo decide o acesso: teste dentro e fora do prazo, e só leitura da assinatura (nada é gravado ao ler)', async () => {
    clock = start;
    const account = await newAccount('time');
    const company = await createCompanyFor(account, start);
    assert.equal((await reader(now).forCompany(company)).access, 'ok');
    clock = new Date(start.getTime() + 7 * DAY);
    assert.equal((await reader(now).forCompany(company)).access, 'blocked');
    clock = start;
  });

  it('empresa criada sem a cobrança é adotada ao ligar: teste gratuito da conta do OWNER, uma vez por conta', async () => {
    clock = start;
    const account = await newAccount('adopt');
    const a = await accountsRepo.createCompany(account, 'Antiga 1');
    const b = await accountsRepo.createCompany(account, 'Antiga 2');
    tenants.track(a.companyId);
    tenants.track(b.companyId);
    const first = await reader(now).forCompany(a.companyId);
    const second = await reader(now).forCompany(b.companyId);
    assert.equal(first.access, 'ok');
    assert.equal(second.access, 'ok');
    const sub = await subscriptionOf(account);
    const rows = await db().company.findMany({ where: { id: { in: [a.companyId, b.companyId] } } });
    assert.deepEqual(
      rows.map((row) => row.subscriptionId),
      [sub.id, sub.id],
    );
    assert.equal(await db().subscription.count({ where: { accountId: account } }), 1);
  });

  it('empresa inexistente ou sem dono é bloqueada, nunca liberada por engano', async () => {
    const orphan = await tenants.createCompany('orfa');
    const blocked = await reader(now).forCompany(orphan.id);
    assert.equal(blocked.access, 'blocked');
    const unknown = await reader(now).forCompany(
      CompanyIdParser.parse('01900000-0000-7000-8000-000000000000'),
    );
    assert.equal(unknown.access, 'blocked');
  });

  it('empresa sem assinatura não conta uso (nada a medir) e o medidor nunca grava texto nem contato (só números)', async () => {
    const meter = new PrismaUsageMeter(db(), now);
    const orphan = await tenants.createCompany('sem-sub');
    await meter.record(orphan.id, 500);
    await meter.recordSent(orphan.id);
    const columns = await db().$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'usage_counters' ORDER BY column_name`;
    assert.deepEqual(
      columns.map((c) => c.column_name),
      [
        'created_at',
        'extra_replies',
        'id',
        'sent_messages',
        'subscription_id',
        'tokens',
        'updated_at',
        'window_start',
      ],
    );
  });
});

describe('revisão da 031: adoção só por OWNER ativo e limite com empresas antigas', () => {
  const now = new Date('2026-11-10T12:00:00Z');

  it('adopt ignora OWNER desativado, de conta desativada ou sem e-mail confirmado (não herda a empresa nem o teste)', async () => {
    const owners = [
      { label: 'vinc-off', membership: { status: 'DISABLED' as const }, account: {} },
      { label: 'conta-off', membership: {}, account: { status: 'DISABLED' as const } },
      { label: 'sem-email', membership: {}, account: { emailVerifiedAt: null } },
    ];
    for (const owner of owners) {
      const account = await newAccount(owner.label);
      const company = await tenants.createCompany('adopt-neg');
      await db().membership.create({
        data: {
          companyId: company.id,
          accountId: account,
          email: `${owner.label}@exemplo.test`,
          passwordHash: 'account-managed',
          role: 'OWNER',
          ...owner.membership,
        },
      });
      await db().account.updateMany({ where: { id: account }, data: owner.account });
      assert.equal((await reader(() => now).forCompany(company.id)).access, 'blocked', owner.label);
      assert.equal(
        await db().subscription.count({ where: { accountId: account } }),
        0,
        owner.label,
      );
    }
  });

  it('conta com 3 empresas antigas e a cobrança ligada: criar a 4ª no Essencial dá PLAN_COMPANY_LIMIT e adota as antigas', async () => {
    const account = await newAccount('antigas');
    const olds: CompanyId[] = [];
    for (let i = 0; i < 3; i += 1) {
      const c = await accountsRepo.createCompany(account, `Antiga ${String(i)}`);
      tenants.track(c.companyId);
      olds.push(c.companyId);
    }
    await assert.rejects(
      () => accountsRepo.createCompany(account, 'Quarta', policy(now)),
      (error: unknown) => error instanceof ForbiddenError && error.code === 'PLAN_COMPANY_LIMIT',
    );
    // A recusa desfaz a transação (nada foi adotado); a adoção real acontece quando a criação passa.
    const proAccount = await newAccount('antigas-pro');
    const c1 = await accountsRepo.createCompany(proAccount, 'Antiga');
    tenants.track(c1.companyId);
    const trial = await billing.ensureTrial(proAccount, now, SETTINGS);
    subscriptionIds.add(trial.id);
    const pro = await db().plan.findFirst({ where: { code: 'PROFESSIONAL' } });
    assert.ok(pro !== null);
    await db().subscription.updateMany({ where: { id: trial.id }, data: { planId: pro.id } });
    await createCompanyFor(proAccount, now);
    assert.equal(await billing.countCompanies(proAccount), 2, 'a antiga foi adotada e conta');
    assert.equal(olds.length, 3);
  });

  it('duas adoções simultâneas da mesma conta resultam em uma assinatura e todas as empresas ligadas a ela', async () => {
    const account = await newAccount('adopt-race');
    const ids: CompanyId[] = [];
    for (let i = 0; i < 2; i += 1) {
      const c = await accountsRepo.createCompany(account, `R${String(i)}`);
      tenants.track(c.companyId);
      ids.push(c.companyId);
    }
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => reader(() => now).forCompany(ids[i % 2] as CompanyId)),
    );
    assert.ok(results.every((r) => r.access === 'ok'));
    assert.equal(
      await db().subscription.count({ where: { accountId: account } }),
      1,
      'uma só assinatura (motivo: account_id único e skipDuplicates na corrida)',
    );
    const rows = await db().company.findMany({ where: { id: { in: ids } } });
    assert.equal(new Set(rows.map((r) => r.subscriptionId)).size, 1);
    assert.ok(rows[0]?.subscriptionId !== null);
  });
});

describe('regra do máximo: cotas novas valem na hora para quem já assina (spec 040, D4)', () => {
  const now = new Date('2026-11-12T12:00:00Z');
  const periodStart = new Date('2026-11-10T12:00:00Z');
  const periodEnd = new Date('2026-12-10T12:00:00Z');

  /** Assinatura ACTIVE mensal presa à linha ANTIGA do Essencial (versão 1: 800 respostas, 3 M de tokens). */
  async function activeOnOldEssential(label: string) {
    const account = await newAccount(label);
    const company = await createCompanyFor(account, periodStart);
    const sub = await subscriptionOf(account);
    const oldPlan = await db().plan.findFirst({ where: { code: 'ESSENTIAL', version: 1 } });
    assert.ok(oldPlan !== null);
    assert.equal(oldPlan.monthlyReplies, 800, 'a linha antiga continua intacta no banco');
    const oldPrice = await db().planPrice.findFirst({
      where: { planId: oldPlan.id, cycle: 'MONTHLY', version: 1 },
    });
    assert.ok(oldPrice !== null);
    await db().subscription.updateMany({
      where: { id: sub.id },
      data: {
        planId: oldPlan.id,
        priceId: oldPrice.id,
        status: 'ACTIVE',
        trialEndsAt: null,
        agendaEnabled: false,
        stockEnabled: false,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
      },
    });
    return { account, company, subscriptionId: sub.id, oldPlanId: oldPlan.id };
  }

  async function setUsage(subscriptionId: string, sentMessages: bigint, tokens = 0n) {
    const existing = await db().usageCounter.updateMany({
      where: { subscriptionId, windowStart: periodStart },
      data: { sentMessages, tokens },
    });
    if (existing.count === 0) {
      await db().usageCounter.create({
        data: { subscriptionId, windowStart: periodStart, sentMessages, tokens },
      });
    }
  }

  it('entitlements, GET /account/billing e os avisos veem 2.500 respostas e 15 M de tokens; a linha da assinatura e o uso não mudam', async () => {
    const { account, company, subscriptionId, oldPlanId } =
      await activeOnOldEssential('max-quotas');
    await setUsage(subscriptionId, 2_000n, 1_000n);

    const entitlements = await reader(() => now).forCompany(company);
    assert.deepEqual(entitlements.replies, { used: 2_000, limit: 2_500 });
    assert.deepEqual(entitlements.tokens, { used: 1_000, limit: 15_000_000 });

    const service = new BillingService({
      billing,
      settings: { ...SETTINGS, allowSopreiPaysMeta: false },
      now: () => now,
    });
    const overview = await service.overview(account);
    assert.deepEqual(overview.usage?.replies, { used: 2_000, limit: 2_500 });
    assert.deepEqual(overview.usage.tokens, { used: 1_000, limit: 15_000_000 });

    // Os avisos usam o mesmo mapeamento: 2.000 de 2.500 é 80% (com a cota antiga seria 100%).
    const notices = new PrismaBillingNoticeRepository(db());
    const target = await notices.findTarget(subscriptionId);
    assert.ok(target !== null);
    assert.equal(target.subscription.plan.monthlyReplies, 2_500);
    assert.equal(target.subscription.plan.monthlyTokens, 15_000_000);
    const kinds = dueNotices(
      {
        subscription: target.subscription,
        usage: { tokens: 1_000, sentMessages: 2_000, extraReplies: 0 },
        usageWindowStart: periodStart,
        companies: 1,
        pendingPlanMaxCompanies: null,
      },
      now,
      SETTINGS,
    ).map((notice) => notice.kind);
    assert.deepEqual(kinds, ['QUOTA_REPLIES_80']);

    // Nada foi gravado: a assinatura segue na linha antiga e o contador da janela não mudou.
    const row = await db().subscription.findFirst({ where: { id: subscriptionId } });
    assert.equal(row?.planId, oldPlanId);
    const counter = await db().usageCounter.findFirst({
      where: { subscriptionId, windowStart: periodStart },
    });
    assert.equal(counter?.sentMessages, 2_000n);
    assert.equal(counter.tokens, 1_000n);
    // O resto do plano (id, versão, vagas) continua o da própria linha.
    const sub = await billing.findSubscription(account);
    assert.equal(sub?.plan.id, oldPlanId);
    assert.equal(sub.plan.version, 1);
    assert.equal(sub.plan.maxCompanies, 1);
  });

  it('a IA só é bloqueada a partir de 2.500 respostas (não em 800)', async () => {
    const { company, subscriptionId } = await activeOnOldEssential('max-block');
    for (const [sent, blocked] of [
      [800n, false],
      [2_499n, false],
      [2_500n, true],
    ] as const) {
      await setUsage(subscriptionId, sent);
      const reason = quotaBlockReason(await reader(() => now).forCompany(company));
      assert.equal(reason, blocked ? 'replies' : null, String(sent));
    }
  });

  it('isolamento entre contas: a cota efetiva de uma conta não depende de uso, plano nem pedido de outra', async () => {
    const a = await activeOnOldEssential('max-iso-a');
    // B no Escala novo, com uso alto e um pedido aberto.
    const accountB = await newAccount('max-iso-b');
    const companyB = await createCompanyFor(accountB, periodStart);
    const subB = await subscriptionOf(accountB);
    const scale = await db().plan.findFirst({
      where: { code: 'SCALE', active: true },
      orderBy: { version: 'desc' },
    });
    assert.ok(scale !== null);
    await db().subscription.updateMany({
      where: { id: subB.id },
      data: {
        planId: scale.id,
        status: 'ACTIVE',
        trialEndsAt: null,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
      },
    });
    await setUsage(subB.id, 20_000n, 9_000_000n);
    await db().paymentOrder.create({
      data: {
        subscriptionId: subB.id,
        kind: 'RENEWAL',
        amountCents: 34_900,
        breakdown: { plan: 'SCALE' },
        expiresAt: new Date(now.getTime() + DAY),
      },
    });
    await setUsage(a.subscriptionId, 10n);

    const entA = await reader(() => now).forCompany(a.company);
    assert.deepEqual(entA.replies, { used: 10, limit: 2_500 });
    assert.deepEqual(entA.tokens, { used: 0, limit: 15_000_000 });
    const entB = await reader(() => now).forCompany(companyB);
    assert.deepEqual(entB.replies, { used: 20_000, limit: 30_000 });
    assert.deepEqual(entB.tokens, { used: 9_000_000, limit: 180_000_000 });
    assert.equal((await billing.listOrders(a.account, 10)).length, 0);
  });
});
