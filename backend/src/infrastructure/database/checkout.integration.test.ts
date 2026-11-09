import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { CheckoutService } from '../../application/billing/checkout.service.js';
import { PaymentReconciler } from '../../application/billing/payment-reconciler.js';
import { PaymentVerifier } from '../../application/billing/payment-verifier.js';
import { deriveWebhookSecret, webhookToken } from '../../application/billing/webhook-token.js';
import { PendingReplyResumer } from '../../application/billing/pending-reply-resumer.js';
import type { FlushJob, FlushSchedule } from '../../application/ports/inbound-job-queue.js';
import { ORDER_MAX_PER_DAY } from '../../domain/index.js';
import { InfinitepayClient } from '../external-apis/infinitepay/infinitepay.client.js';
import { createLogger } from '../logger/logger.js';
import { createMetrics } from '../metrics/index.js';
import { ConflictError, NotFoundError } from '../../shared/errors/index.js';
import { Result, SecretString } from '../../shared/types/index.js';
import { FakeInfinitepayApi } from '../../test-support/fake-infinitepay-api.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import { createDatabase, type Database } from './database.js';
import { PrismaBillingRepository } from './repositories/billing.repository.js';
import { PrismaCheckoutRepository } from './repositories/checkout.repository.js';
import { PrismaPendingReplyReader } from './repositories/pending-reply-reader.js';

// Spec 031 (E3): checkout da InfinitePay contra o Postgres real (soprei_test) e o servidor falso. Nenhuma
// chamada real, nenhuma chave real. Pool 30 e prazo 30 s por causa da concorrência (as confirmações simultâneas
// seguram conexões em transação).
const baseConfig = loadIntegrationConfig();
const config = { ...baseConfig, DB_POOL_MAX: 30, DB_POOL_CONNECTION_TIMEOUT_MS: 30_000 };
const DAY = 86_400_000;
const GRACE = 5;
const API_KEY = `inchk_${randomBytes(12).toString('hex')}`;
const EMAIL_SENTINEL = 'sentinela-email';
const APP_ORIGIN = 'https://site.exemplo.test';
const WEBHOOK_BASE = 'https://api.exemplo.test';
const WEBHOOK_SECRET = deriveWebhookSecret('segredo-de-teste-do-webhook-0123456789');
const tokenFor = (orderId: string): string => webhookToken(WEBHOOK_SECRET, orderId);
const SETTINGS = { graceDays: GRACE, trialDays: 7, trialTokens: 300_000 };

let database: Database;
let tenants: TestTenants;
let billing: PrismaBillingRepository;
let checkoutRepo: PrismaCheckoutRepository;
let fake: FakeInfinitepayApi;
let clock = new Date('2026-11-10T12:00:00Z');
const accountIds: string[] = [];
const subscriptionIds = new Set<string>();
const sleeps: number[] = [];

function db() {
  return database.prisma;
}

interface Stack {
  readonly service: CheckoutService;
  readonly verifier: PaymentVerifier;
  readonly reconciler: PaymentReconciler;
  readonly logs: ReturnType<typeof captureLogs>;
  readonly metrics: ReturnType<typeof createMetrics>;
  readonly flushes: { job: FlushJob; schedule: FlushSchedule }[];
}

/** Remove os pedidos em aberto (PENDING e EXPIRED com link) destes testes, que a reconciliação veria. */
async function clearOpenOrders(): Promise<void> {
  await db().paymentOrder.deleteMany({
    where: { subscriptionId: { in: [...subscriptionIds] }, status: { in: ['PENDING', 'EXPIRED'] } },
  });
}

function stack(
  options: {
    apiKey?: string;
    timeoutMs?: number;
    sendEmail?: boolean;
    cooldownMs?: number;
    maxBackground?: number;
  } = {},
): Stack {
  const logs = captureLogs();
  const metrics = createMetrics();
  const flushes: Stack['flushes'] = [];
  const provider = new InfinitepayClient({
    baseUrl: fake.baseUrl,
    apiKey: new SecretString(options.apiKey ?? API_KEY),
    handle: 'loja-teste',
    timeoutMs: options.timeoutMs ?? 2_000,
    checkoutHost: '127.0.0.1',
  });
  const resumer = new PendingReplyResumer({
    reader: new PrismaPendingReplyReader(db()),
    queue: {
      scheduleFlush: (job, schedule) => {
        flushes.push({ job, schedule });
        return Promise.resolve(Result.ok(undefined));
      },
    },
    logger: logs.logger,
  });
  const verifier = new PaymentVerifier({
    checkout: checkoutRepo,
    provider,
    graceDays: GRACE,
    logger: logs.logger,
    metrics,
    resumer,
    cooldownMs: options.cooldownMs ?? 0,
    ...(options.maxBackground === undefined ? {} : { maxBackground: options.maxBackground }),
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  const service = new CheckoutService({
    billing,
    checkout: checkoutRepo,
    provider,
    verifier,
    settings: {
      graceDays: GRACE,
      appOrigin: APP_ORIGIN,
      webhookBaseUrl: WEBHOOK_BASE,
      allowSopreiPaysMeta: false,
      webhookSecret: WEBHOOK_SECRET,
      sendCustomerEmail: options.sendEmail ?? false,
    },
    logger: logs.logger,
    metrics,
    now: () => clock,
  });
  const reconciler = new PaymentReconciler({
    checkout: checkoutRepo,
    verifier,
    logger: logs.logger,
    now: () => clock,
  });
  return { service, verifier, reconciler, logs, metrics, flushes };
}

async function newAccount(label: string): Promise<{ id: string; email: string }> {
  const email = `${EMAIL_SENTINEL}-${label}-${randomBytes(5).toString('hex')}@exemplo.test`;
  const row = await db().account.create({
    data: { email, passwordHash: 'x', emailVerifiedAt: new Date() },
  });
  accountIds.push(row.id);
  return { id: row.id, email };
}

async function accountWithTrial(label: string) {
  const account = await newAccount(label);
  const subscription = await billing.ensureTrial(account.id, clock, SETTINGS);
  subscriptionIds.add(subscription.id);
  return { account, subscription };
}

const ESSENTIAL_AGENDA = {
  planCode: 'ESSENTIAL',
  cycle: 'MONTHLY',
  agenda: true,
  stock: false,
} as const;
// Essencial mensal (R$ 59,00) + Agenda (R$ 29,00).
const ESSENTIAL_AGENDA_CENTS = 5_900 + 2_900;

before(async () => {
  database = createDatabase(config, createLogger(config));
  tenants = new TestTenants(database.prisma);
  billing = new PrismaBillingRepository(database.prisma);
  checkoutRepo = new PrismaCheckoutRepository(database.prisma);
  fake = new FakeInfinitepayApi(API_KEY);
  await fake.start();
});

beforeEach(() => {
  clock = new Date('2026-11-10T12:00:00Z');
  fake.failLinks(undefined);
  fake.failChecks(undefined);
  fake.setLinkResponse(undefined);
  sleeps.length = 0;
});

after(async () => {
  try {
    await tenants.cleanup();
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
    await fake.stop();
    await database.close();
  }
});

describe('criar o pedido e o link (spec 031, E3)', () => {
  it('o valor sai do catálogo no servidor e o link leva só o mínimo ao provedor', async () => {
    const s = stack({ sendEmail: true });
    const { account } = await accountWithTrial('create');
    const created = await s.service.createOrder(account, ESSENTIAL_AGENDA);
    assert.equal(created.amountCents, ESSENTIAL_AGENDA_CENTS);
    assert.match(created.checkoutUrl, /\/pay\//);
    assert.equal(created.expiresAt.getTime(), clock.getTime() + DAY);

    const call = fake.callsTo('/links').at(-1);
    assert.ok(call !== undefined);
    assert.equal(call.apiKey, API_KEY);
    const body = call.body;
    assert.equal(body.order_nsu, created.orderId);
    assert.equal(body.handle, 'loja-teste');
    assert.deepEqual(body.items, [
      {
        quantity: 1,
        price: ESSENTIAL_AGENDA_CENTS,
        description: 'Soprei Essencial mensal + Agenda',
      },
    ]);
    assert.equal(body.redirect_url, `${APP_ORIGIN}/painel/assinatura`);
    // O mínimo do pagador: só o e-mail da conta, nunca telefone nem endereço.
    assert.deepEqual(body.customer, { email: account.email });
    // O token da webhook_url é o HMAC do pedido (autentica o webhook público).
    assert.equal(
      body.webhook_url,
      `${WEBHOOK_BASE}/webhooks/infinitepay/${created.orderId}/${tokenFor(created.orderId)}`,
    );
    assert.equal('address' in body, false);
    const options = body.options as Record<string, unknown>;
    assert.equal(options.single_payment, true);
    assert.equal(options.assured_installments, 0);
    assert.deepEqual(options.payment_methods_enabled, ['credit_card', 'pix']);
    const validUntil = new Date(String(options.valid_until)).getTime();
    assert.ok(validUntil > clock.getTime() && validUntil <= clock.getTime() + 366 * DAY);
    assert.equal('discounts' in options, false);

    const order = await checkoutRepo.findOrder(account.id, created.orderId);
    assert.equal(order?.status, 'PENDING');
    assert.equal(order.kind, 'NEW');
    assert.equal(order.amountCents, ESSENTIAL_AGENDA_CENTS);
    assert.equal(order.checkoutUrl, created.checkoutUrl);
    assert.equal(order.breakdown.planCode, 'ESSENTIAL');
    assert.equal(order.breakdown.agenda, true);
    assert.equal(order.breakdown.stock, false);
    assert.ok(order.breakdown.priceId.length > 10);
  });

  it('um segundo pedido do mesmo tipo expira o primeiro (um PENDING por assinatura e tipo)', async () => {
    const s = stack();
    const { account } = await accountWithTrial('replace');
    const first = await s.service.createOrder(account, ESSENTIAL_AGENDA);
    const second = await s.service.createOrder(account, { ...ESSENTIAL_AGENDA, stock: true });
    assert.equal((await checkoutRepo.findOrder(account.id, first.orderId))?.status, 'EXPIRED');
    assert.equal((await checkoutRepo.findOrder(account.id, second.orderId))?.status, 'PENDING');
    assert.equal(second.amountCents, ESSENTIAL_AGENDA_CENTS + 1_900);
  });

  it('falha do provedor ao criar o link: 502 com code fixo e nenhum pedido pendurado', async () => {
    const s = stack();
    const { account } = await accountWithTrial('linkfail');
    fake.failLinks({ kind: 'status', status: 500 });
    await assert.rejects(s.service.createOrder(account, ESSENTIAL_AGENDA), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'CHECKOUT_UNAVAILABLE');
      assert.equal((error as { statusCode?: number }).statusCode, 502);
      return true;
    });
    assert.deepEqual(await billing.listOrders(account.id, 10), []);
    fake.failLinks({ kind: 'drop' });
    await assert.rejects(s.service.createOrder(account, ESSENTIAL_AGENDA));
    assert.deepEqual(await billing.listOrders(account.id, 10), []);
  });

  it('credencial recusada (403) ao criar: erro de configuração, nada pendurado, alerta e métrica', async () => {
    const s = stack({ apiKey: 'inchk_chave_errada_0000' });
    const { account } = await accountWithTrial('badkey');
    await assert.rejects(s.service.createOrder(account, ESSENTIAL_AGENDA), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'CHECKOUT_UNAVAILABLE');
      return true;
    });
    assert.deepEqual(await billing.listOrders(account.id, 10), []);
    assert.match(
      await s.metrics.render(),
      /billing_orders_total\{kind="NEW",result="provider_config"\} 1/,
    );
    assert.ok(s.logs.lines().some((line) => line.level === 50));
    assert.equal(s.logs.raw().includes('inchk_chave_errada_0000'), false);
  });

  it('link fora do formato (esquema perigoso) é recusado e nada fica pendurado', async () => {
    const s = stack();
    const { account } = await accountWithTrial('badlink');
    fake.setLinkResponse({ url: 'javascript:alert(1)' });
    await assert.rejects(s.service.createOrder(account, ESSENTIAL_AGENDA));
    assert.deepEqual(await billing.listOrders(account.id, 10), []);
    fake.setLinkResponse({ outra: 'coisa' });
    await assert.rejects(s.service.createOrder(account, ESSENTIAL_AGENDA));
    assert.deepEqual(await billing.listOrders(account.id, 10), []);
  });

  it('sem assinatura (conta sem empresa) o pedido é recusado e nada é criado', async () => {
    const s = stack();
    const account = await newAccount('nosub');
    await assert.rejects(
      s.service.createOrder(account, ESSENTIAL_AGENDA),
      (error: unknown) => error instanceof ConflictError && error.code === 'NO_SUBSCRIPTION',
    );
  });

  it('plano menor que o número de empresas atuais é recusado (PLAN_DOWNGRADE_BLOCKED), sem apagar nada', async () => {
    const s = stack();
    const { account, subscription } = await accountWithTrial('downgrade');
    for (const label of ['d1', 'd2']) {
      const company = await tenants.createCompany(label);
      await db().company.updateMany({
        where: { id: company.id },
        data: { subscriptionId: subscription.id },
      });
    }
    await assert.rejects(
      s.service.createOrder(account, ESSENTIAL_AGENDA),
      (error: unknown) => error instanceof ConflictError && error.code === 'PLAN_DOWNGRADE_BLOCKED',
    );
    assert.equal(await billing.countCompanies(account.id), 2);
    // O plano que comporta as duas empresas passa.
    const created = await s.service.createOrder(account, {
      ...ESSENTIAL_AGENDA,
      planCode: 'PROFESSIONAL',
    });
    assert.equal(created.amountCents, 14_900 + 4_900);
  });

  it('teto de pedidos por assinatura em 24 h', async () => {
    const s = stack();
    const { account } = await accountWithTrial('cap');
    for (let index = 0; index < ORDER_MAX_PER_DAY; index += 1) {
      await s.service.createOrder(account, ESSENTIAL_AGENDA);
    }
    await assert.rejects(
      s.service.createOrder(account, ESSENTIAL_AGENDA),
      (error: unknown) => (error as { code?: string }).code === 'ORDER_LIMIT_REACHED',
    );
  });
});

describe('webhook, confirmação e concessão (spec 031, E3)', () => {
  it('webhook com pagamento aprovado: pedido PAID, assinatura ACTIVE com plano, ciclo e módulos do pedido; paid_amount maior é aceito', async () => {
    const s = stack();
    const { account, subscription } = await accountWithTrial('paid');
    const created = await s.service.createOrder(account, ESSENTIAL_AGENDA);
    // O pagador pagou no cartão em 3x: as taxas repassadas deixam o valor pago maior que o do link.
    fake.markPaid(created.orderId, {
      amount: ESSENTIAL_AGENDA_CENTS,
      paidAmount: ESSENTIAL_AGENDA_CENTS + 360,
      captureMethod: 'credit_card',
    });
    clock = new Date(clock.getTime() + 60_000);
    const outcome = await s.service.acceptWebhook(created.orderId, tokenFor(created.orderId), {
      orderNsu: created.orderId,
      transactionNsu: 'tx-123',
      invoiceSlug: 'slug-123',
    });
    assert.equal(outcome, 'recorded');
    await s.verifier.drain();

    const order = await checkoutRepo.findOrder(account.id, created.orderId);
    assert.equal(order?.status, 'PAID');
    // Referência vinda do corpo do webhook (não confiável) nunca é gravada: a consulta usou só handle e order_nsu.
    assert.equal(order.providerTransactionRef, null);
    assert.equal(order.providerSlug, null);
    assert.equal(order.paidAt?.getTime(), clock.getTime());
    assert.equal(order.periodStart?.getTime(), clock.getTime());
    const after = await billing.findSubscription(account.id);
    assert.equal(after?.id, subscription.id);
    assert.equal(after.status, 'ACTIVE');
    assert.equal(after.plan.code, 'ESSENTIAL');
    assert.equal(after.cycle, 'MONTHLY');
    assert.equal(after.agendaEnabled, true);
    assert.equal(after.stockEnabled, false);
    assert.equal(after.trialEndsAt, null);
    assert.equal(after.currentPeriodStart.getTime(), clock.getTime());
    assert.equal(after.currentPeriodEnd.toISOString(), '2026-12-10T12:01:00.000Z');
    // A consulta levou a chave e as referências do evento, nunca valores do corpo do webhook.
    const check = fake.callsTo('/payment_check').at(-1);
    assert.equal(check?.apiKey, API_KEY);
    assert.deepEqual(check.body, { handle: 'loja-teste', order_nsu: created.orderId });
    // A janela de uso do período novo já existe.
    const counters = await db().usageCounter.findMany({
      where: { subscriptionId: subscription.id },
    });
    assert.ok(counters.some((c) => c.windowStart.getTime() === clock.getTime()));
  });

  it('pagamento anual estende 12 meses e abre 12 janelas de uso (cota mensal)', async () => {
    const s = stack();
    const { account } = await accountWithTrial('annual');
    const created = await s.service.createOrder(account, { ...ESSENTIAL_AGENDA, cycle: 'ANNUAL' });
    assert.equal(created.amountCents, 56_640 + 27_840);
    fake.markPaid(created.orderId, { amount: created.amountCents });
    assert.equal(await s.verifier.verify(created.orderId), 'paid');
    const sub = await billing.findSubscription(account.id);
    assert.equal(sub?.cycle, 'ANNUAL');
    assert.equal(sub.currentPeriodEnd.toISOString(), '2027-11-10T12:00:00.000Z');
  });

  it('o mesmo webhook repetido 10 vezes em paralelo concede uma única vez', async () => {
    const s = stack();
    const { account } = await accountWithTrial('parallel');
    const created = await s.service.createOrder(account, ESSENTIAL_AGENDA);
    fake.markPaid(created.orderId, { amount: ESSENTIAL_AGENDA_CENTS });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => s.verifier.verify(created.orderId)),
    );
    // Motivo na asserção: só uma confirmação concede; as outras já encontram o pedido pago.
    assert.equal(results.filter((r) => r === 'paid').length, 1, `resultados: ${results.join(',')}`);
    assert.equal(results.filter((r) => r === 'already_paid').length, 9);
    const sub = await billing.findSubscription(account.id);
    assert.equal(sub?.currentPeriodEnd.toISOString(), '2026-12-10T12:00:00.000Z');
    const granted = await Promise.all(
      Array.from({ length: 10 }, () =>
        checkoutRepo.grantPaidOrder(
          created.orderId,
          { transactionNsu: null, slug: null, captureMethod: null },
          clock,
          GRACE,
        ),
      ),
    );
    assert.equal(granted.filter((g) => g.granted).length, 0);
    const again = await billing.findSubscription(account.id);
    assert.equal(again?.currentPeriodEnd.toISOString(), '2026-12-10T12:00:00.000Z');
    assert.equal(
      await db().paymentOrder.count({ where: { id: created.orderId, status: 'PAID' } }),
      1,
    );
  });

  it('dois pedidos pagos ao mesmo tempo somam os dois períodos (a linha da assinatura é travada)', async () => {
    const s = stack();
    const { account } = await accountWithTrial('twoorders');
    const first = await s.service.createOrder(account, ESSENTIAL_AGENDA);
    const second = await s.service.createOrder(account, ESSENTIAL_AGENDA);
    fake.markPaid(first.orderId, { amount: first.amountCents });
    fake.markPaid(second.orderId, { amount: second.amountCents });
    // O primeiro já está EXPIRED (substituído), mas o dinheiro não se perde: ambos são concedidos.
    const results = await Promise.all([
      s.verifier.verify(first.orderId),
      s.verifier.verify(second.orderId),
    ]);
    assert.deepEqual([...results].sort(), ['paid', 'paid']);
    const sub = await billing.findSubscription(account.id);
    assert.equal(sub?.currentPeriodEnd.toISOString(), '2027-01-10T12:00:00.000Z');
  });

  it('corpo do webhook que diz "pago" mas o payment_check diz não pago: nada é concedido', async () => {
    const s = stack();
    const { account } = await accountWithTrial('lie');
    const created = await s.service.createOrder(account, ESSENTIAL_AGENDA);
    // O provedor NÃO marcou o pedido como pago; o corpo do webhook jura que sim (e o valor).
    await s.service.acceptWebhook(created.orderId, tokenFor(created.orderId), {
      orderNsu: created.orderId,
      transactionNsu: 'tx-fake',
      invoiceSlug: 'slug-fake',
    });
    await s.verifier.drain();
    assert.equal((await checkoutRepo.findOrder(account.id, created.orderId))?.status, 'PENDING');
    assert.equal((await billing.findSubscription(account.id))?.status, 'TRIAL');
  });

  it('valor confirmado diferente do pedido: não concede, NÃO é terminal (segue PENDING) e uma confirmação correta depois concede', async () => {
    const s = stack();
    const { account } = await accountWithTrial('mismatch');
    const created = await s.service.createOrder(account, ESSENTIAL_AGENDA);
    fake.markPaid(created.orderId, { amount: 100, paidAmount: 100 });
    assert.equal(await s.verifier.verify(created.orderId), 'amount_mismatch');
    assert.equal((await checkoutRepo.findOrder(account.id, created.orderId))?.status, 'PENDING');
    assert.equal((await billing.findSubscription(account.id))?.status, 'TRIAL');
    assert.ok(s.logs.lines().some((line) => line.level === 50));
    assert.match(
      await s.metrics.render(),
      /billing_orders_total\{kind="NEW",result="amount_mismatch"\} 1/,
    );
    // A igualdade amount == amountCents continua a única porta.
    fake.markPaid(created.orderId, { amount: created.amountCents });
    assert.equal(await s.verifier.verify(created.orderId), 'paid');
    assert.equal((await billing.findSubscription(account.id))?.status, 'ACTIVE');
  });

  it('403 do provedor no payment_check é erro de configuração (alerta), nunca "não pago"', async () => {
    const s = stack({ apiKey: 'inchk_chave_errada_0000' });
    const good = stack();
    const { account } = await accountWithTrial('check403');
    const created = await good.service.createOrder(account, ESSENTIAL_AGENDA);
    fake.markPaid(created.orderId, { amount: created.amountCents });
    assert.equal(await s.verifier.verify(created.orderId), 'config_error');
    assert.equal((await checkoutRepo.findOrder(account.id, created.orderId))?.status, 'PENDING');
    assert.match(await s.metrics.render(), /billing_checks_total\{result="config_error"\} 1/);
    assert.ok(s.logs.lines().some((line) => line.level === 50));
    // Com a configuração certa, o mesmo pedido é concedido.
    assert.equal(await good.verifier.verify(created.orderId), 'paid');
  });

  it('falha transitória (429, 5xx, queda) não concede e é repetida em segundo plano; depois concede', async () => {
    const s = stack();
    const { account } = await accountWithTrial('flaky');
    const created = await s.service.createOrder(account, ESSENTIAL_AGENDA);
    fake.markPaid(created.orderId, { amount: created.amountCents });
    for (const failure of [
      { kind: 'status', status: 429, retryAfter: '1' },
      { kind: 'status', status: 503 },
      { kind: 'drop' },
    ] as const) {
      fake.failChecks(failure);
      assert.equal(await s.verifier.verify(created.orderId), 'unavailable');
      assert.equal((await checkoutRepo.findOrder(account.id, created.orderId))?.status, 'PENDING');
    }
    // Em segundo plano: duas falhas seguidas, esperas de 1 s e 5 s (sem dormir de verdade) e a terceira passa.
    fake.failChecks({ kind: 'status', status: 503 }, 2);
    s.verifier.verifyInBackground(created.orderId, {});
    await s.verifier.drain();
    assert.deepEqual(sleeps, [1_000, 5_000]);
    assert.equal((await checkoutRepo.findOrder(account.id, created.orderId))?.status, 'PAID');
  });

  it('se todas as tentativas em segundo plano falham, nada é concedido e a reconciliação fica com o pedido', async () => {
    const s = stack();
    const { account } = await accountWithTrial('allfail');
    const created = await s.service.createOrder(account, ESSENTIAL_AGENDA);
    fake.markPaid(created.orderId, { amount: created.amountCents });
    fake.failChecks({ kind: 'status', status: 503 });
    s.verifier.verifyInBackground(created.orderId, {});
    await s.verifier.drain();
    assert.equal((await checkoutRepo.findOrder(account.id, created.orderId))?.status, 'PENDING');
    assert.equal(sleeps.length, 2);
    fake.failChecks(undefined);
    assert.equal(await s.verifier.verify(created.orderId), 'paid');
  });

  it('provedor lento além do prazo vira indisponível (nada concedido)', async () => {
    const s = stack({ timeoutMs: 100 });
    const { account } = await accountWithTrial('slow');
    const created = await s.service.createOrder(account, ESSENTIAL_AGENDA);
    fake.markPaid(created.orderId, { amount: created.amountCents });
    fake.failChecks({ kind: 'slow', ms: 600 });
    assert.equal(await s.verifier.verify(created.orderId), 'unavailable');
    assert.equal((await checkoutRepo.findOrder(account.id, created.orderId))?.status, 'PENDING');
  });

  it('pedido inexistente, malformado ou com order_nsu de outra rota: nada acontece e o provedor não é chamado', async () => {
    const s = stack();
    const { account } = await accountWithTrial('unknown');
    const created = await s.service.createOrder(account, ESSENTIAL_AGENDA);
    const before = fake.callsTo('/payment_check').length;
    const event = { orderNsu: undefined, transactionNsu: 'tx', invoiceSlug: 'sl' };
    assert.equal(
      await s.service.acceptWebhook(
        '01900000-0000-7000-8000-00000000dead',
        tokenFor('01900000-0000-7000-8000-00000000dead'),
        event,
      ),
      'unknown_order',
    );
    assert.equal(
      await s.service.acceptWebhook('nao-e-uuid', 'x'.repeat(43), event),
      'unknown_order',
    );
    assert.equal(
      await s.service.acceptWebhook(created.orderId, tokenFor(created.orderId), {
        ...event,
        orderNsu: 'outro-pedido',
      }),
      'unknown_order',
    );
    await s.verifier.drain();
    assert.equal(fake.callsTo('/payment_check').length, before);
    assert.equal(
      (await checkoutRepo.findOrder(account.id, created.orderId))?.providerTransactionRef,
      null,
    );
  });

  it('pedido já pago: evento repetido é duplicata e não consulta de novo', async () => {
    const s = stack();
    const { account } = await accountWithTrial('dup');
    const created = await s.service.createOrder(account, ESSENTIAL_AGENDA);
    fake.markPaid(created.orderId, { amount: created.amountCents });
    assert.equal(await s.verifier.verify(created.orderId), 'paid');
    const calls = fake.callsTo('/payment_check').length;
    const event = { orderNsu: created.orderId, transactionNsu: 'tx', invoiceSlug: 'sl' };
    assert.equal(
      await s.service.acceptWebhook(created.orderId, tokenFor(created.orderId), event),
      'duplicate',
    );
    assert.equal(fake.callsTo('/payment_check').length, calls);
  });

  it('B1: referência do corpo nunca é gravada antes de uma confirmação paga e não envenena o pedido', async () => {
    const s = stack();
    const { account } = await accountWithTrial('poison');
    const created = await s.service.createOrder(account, ESSENTIAL_AGENDA);
    await s.service.acceptWebhook(created.orderId, tokenFor(created.orderId), {
      orderNsu: created.orderId,
      transactionNsu: 'envenenada',
      invoiceSlug: 'envenenada',
    });
    await s.verifier.drain();
    const order = await checkoutRepo.findOrder(account.id, created.orderId);
    assert.equal(order?.providerTransactionRef, null);
    assert.equal(order.providerSlug, null);
    assert.equal(order.status, 'PENDING');
    // Pagamento verdadeiro depois: concede normalmente.
    fake.markPaid(created.orderId, { amount: created.amountCents });
    assert.equal(await s.verifier.verify(created.orderId), 'paid');
  });

  it('B1: sem as referências a consulta usa só handle e order_nsu; o provedor que as exige (4xx) recebe a segunda tentativa e a referência só é gravada depois do pago', async () => {
    const s = stack();
    const { account } = await accountWithTrial('strategy');
    const created = await s.service.createOrder(account, ESSENTIAL_AGENDA);
    fake.markPaid(created.orderId, { amount: created.amountCents });
    fake.requireRefs(true);
    try {
      const before = fake.callsTo('/payment_check').length;
      assert.equal(
        await s.verifier.verify(created.orderId, { transactionNsu: 'tx-ok', slug: 'slug-ok' }),
        'paid',
      );
      const calls = fake.callsTo('/payment_check').slice(before);
      assert.equal(calls.length, 2);
      assert.deepEqual(Object.keys(calls[0]?.body ?? {}).sort(), ['handle', 'order_nsu']);
      assert.equal(calls[1]?.body.transaction_nsu, 'tx-ok');
      assert.equal(calls[1].body.slug, 'slug-ok');
    } finally {
      fake.requireRefs(false);
    }
    const order = await checkoutRepo.findOrder(account.id, created.orderId);
    assert.equal(order?.providerTransactionRef, 'tx-ok');
    assert.equal(order.providerSlug, 'slug-ok');
  });

  it('B1: o provedor exige as referências e elas não vieram: rejected, nada concedido, sem alarme', async () => {
    const s = stack();
    const { account } = await accountWithTrial('norefs');
    const created = await s.service.createOrder(account, ESSENTIAL_AGENDA);
    fake.markPaid(created.orderId, { amount: created.amountCents });
    fake.requireRefs(true);
    try {
      assert.equal(await s.verifier.verify(created.orderId), 'rejected');
    } finally {
      fake.requireRefs(false);
    }
    assert.equal((await checkoutRepo.findOrder(account.id, created.orderId))?.status, 'PENDING');
  });

  it('B1: a mesma referência reutilizada em dois pedidos concede só um; o segundo desfaz a transação, não concede e conta a métrica', async () => {
    const s = stack();
    const a = await accountWithTrial('reuse-a');
    const b = await accountWithTrial('reuse-b');
    const orderA = await s.service.createOrder(a.account, ESSENTIAL_AGENDA);
    const orderB = await s.service.createOrder(b.account, ESSENTIAL_AGENDA);
    fake.markPaid(orderA.orderId, { amount: orderA.amountCents });
    fake.markPaid(orderB.orderId, { amount: orderB.amountCents });
    fake.requireRefs(true);
    try {
      assert.equal(
        await s.verifier.verify(orderA.orderId, {
          transactionNsu: 'tx-compartilhada',
          slug: 'slug-a',
        }),
        'paid',
      );
      // Um atacante paga o próprio pedido e reaproveita a referência: a unicidade do banco recusa.
      assert.equal(
        await s.verifier.verify(orderB.orderId, {
          transactionNsu: 'tx-compartilhada',
          slug: 'slug-b',
        }),
        'reference_conflict',
      );
    } finally {
      fake.requireRefs(false);
    }
    assert.equal((await checkoutRepo.findOrder(b.account.id, orderB.orderId))?.status, 'PENDING');
    assert.equal((await billing.findSubscription(b.account.id))?.status, 'TRIAL');
    assert.equal((await billing.findSubscription(a.account.id))?.status, 'ACTIVE');
    assert.match(
      await s.metrics.render(),
      /billing_orders_total\{kind="NEW",result="reference_conflict"\} 1/,
    );
  });

  it('B1: tentativa de forçar FAILED com referência alheia não altera o pedido legítimo', async () => {
    const s = stack();
    const { account } = await accountWithTrial('force');
    const created = await s.service.createOrder(account, ESSENTIAL_AGENDA);
    fake.markPaid(created.orderId, { amount: 1 });
    await s.verifier.verify(created.orderId, { transactionNsu: 'alheia', slug: 'alheia' });
    assert.equal((await checkoutRepo.findOrder(account.id, created.orderId))?.status, 'PENDING');
  });

  it('B1: token inválido, ausente ou de outro pedido responde como desconhecido: nada acontece e o provedor não é chamado', async () => {
    const s = stack();
    const a = await accountWithTrial('tok-a');
    const created = await s.service.createOrder(a.account, ESSENTIAL_AGENDA);
    const other = await s.service.createOrder(
      (await accountWithTrial('tok-b')).account,
      ESSENTIAL_AGENDA,
    );
    fake.markPaid(created.orderId, { amount: created.amountCents });
    const before = fake.callsTo('/payment_check').length;
    const event = { orderNsu: created.orderId, transactionNsu: 'tx', invoiceSlug: 'sl' };
    for (const token of [
      '',
      'curto',
      'x'.repeat(43),
      tokenFor(other.orderId),
      tokenFor(created.orderId) + 'a',
    ]) {
      assert.equal(await s.service.acceptWebhook(created.orderId, token, event), 'bad_token');
    }
    await s.verifier.drain();
    assert.equal(fake.callsTo('/payment_check').length, before);
    assert.equal((await checkoutRepo.findOrder(a.account.id, created.orderId))?.status, 'PENDING');
    assert.equal(
      await s.service.acceptWebhook(created.orderId, tokenFor(created.orderId), event),
      'recorded',
    );
    await s.verifier.drain();
    assert.equal((await checkoutRepo.findOrder(a.account.id, created.orderId))?.status, 'PAID');
  });
});

describe('"Já paguei" e isolamento entre contas (spec 031, E3)', () => {
  it('confirma o pedido da própria conta e trata o de outra conta como inexistente', async () => {
    const s = stack();
    const a = await accountWithTrial('ja-a');
    const b = await accountWithTrial('ja-b');
    const created = await s.service.createOrder(a.account, ESSENTIAL_AGENDA);
    fake.markPaid(created.orderId, { amount: created.amountCents });

    // A conta B não consulta, não concede e recebe o mesmo 404 de um pedido que não existe.
    const callsBefore = fake.callsTo('/payment_check').length;
    await assert.rejects(
      s.service.checkOrder(b.account.id, created.orderId),
      (error: unknown) => error instanceof NotFoundError,
    );
    await assert.rejects(
      s.service.checkOrder(b.account.id, 'não-uuid'),
      (error: unknown) => error instanceof NotFoundError,
    );
    assert.equal(fake.callsTo('/payment_check').length, callsBefore);
    assert.equal((await billing.findSubscription(b.account.id))?.status, 'TRIAL');

    // Referências do retorno do checkout só viram parâmetro da consulta.
    const result = await s.service.checkOrder(a.account.id, created.orderId, {
      transactionNsu: 'tx-retorno',
      slug: 'slug-retorno',
    });
    assert.equal(result.result, 'paid');
    assert.equal(result.order.status, 'PAID');
    // A referência do retorno é só dica: a primeira consulta saiu sem ela e foi suficiente.
    assert.equal(fake.callsTo('/payment_check').at(-1)?.body.transaction_nsu, undefined);
    // A assinatura de B não mudou e a de A foi estendida.
    assert.equal((await billing.findSubscription(a.account.id))?.status, 'ACTIVE');
    assert.equal((await billing.findSubscription(b.account.id))?.status, 'TRIAL');
    // Pedido de A não aparece nas listas de B.
    assert.deepEqual(await billing.listOrders(b.account.id, 10), []);
  });

  it('o webhook de um pedido concede só à assinatura do próprio pedido', async () => {
    const s = stack();
    const a = await accountWithTrial('own-a');
    const b = await accountWithTrial('own-b');
    const orderB = await s.service.createOrder(b.account, ESSENTIAL_AGENDA);
    fake.markPaid(orderB.orderId, { amount: orderB.amountCents });
    await s.service.acceptWebhook(orderB.orderId, tokenFor(orderB.orderId), {
      orderNsu: orderB.orderId,
      transactionNsu: 'tx',
      invoiceSlug: 'sl',
    });
    await s.verifier.drain();
    assert.equal((await billing.findSubscription(b.account.id))?.status, 'ACTIVE');
    assert.equal((await billing.findSubscription(a.account.id))?.status, 'TRIAL');
  });
});

describe('renovação e períodos (spec 031, E3)', () => {
  async function activate(label: string) {
    const s = stack();
    const { account, subscription } = await accountWithTrial(label);
    const first = await s.service.createOrder(account, ESSENTIAL_AGENDA);
    fake.markPaid(first.orderId, { amount: first.amountCents });
    assert.equal(await s.verifier.verify(first.orderId), 'paid');
    return { s, account, subscription };
  }

  it('renovação antecipada soma a partir do fim atual (sem deriva) e o pedido é RENEWAL', async () => {
    const { s, account } = await activate('renew');
    clock = new Date('2026-12-01T00:00:00Z'); // ainda dentro do período (termina em 2026-12-10T12:00Z)
    const renewal = await s.service.createOrder(account, ESSENTIAL_AGENDA);
    const order = await checkoutRepo.findOrder(account.id, renewal.orderId);
    assert.equal(order?.kind, 'RENEWAL');
    fake.markPaid(renewal.orderId, { amount: renewal.amountCents });
    assert.equal(await s.verifier.verify(renewal.orderId), 'paid');
    const sub = await billing.findSubscription(account.id);
    assert.equal(sub?.currentPeriodStart.toISOString(), '2026-11-10T12:00:00.000Z');
    assert.equal(sub.currentPeriodEnd.toISOString(), '2027-01-10T12:00:00.000Z');
    assert.equal(sub.status, 'ACTIVE');
  });

  it('paga dentro da carência continua do fim anterior; passada a carência, recomeça no pagamento', async () => {
    const { s, account } = await activate('grace');
    clock = new Date('2026-12-12T00:00:00Z'); // vencida em 12-10T12, dentro dos 5 dias de carência
    const inGrace = await s.service.createOrder(account, ESSENTIAL_AGENDA);
    fake.markPaid(inGrace.orderId, { amount: inGrace.amountCents });
    assert.equal(await s.verifier.verify(inGrace.orderId), 'paid');
    let sub = await billing.findSubscription(account.id);
    assert.equal(sub?.currentPeriodEnd.toISOString(), '2027-01-10T12:00:00.000Z');

    // Muito depois (passou o fim + carência): o novo pagamento recomeça em "agora".
    clock = new Date('2027-03-01T00:00:00Z');
    const late = await s.service.createOrder(account, ESSENTIAL_AGENDA);
    assert.equal((await checkoutRepo.findOrder(account.id, late.orderId))?.kind, 'NEW');
    fake.markPaid(late.orderId, { amount: late.amountCents });
    assert.equal(await s.verifier.verify(late.orderId), 'paid');
    sub = await billing.findSubscription(account.id);
    assert.equal(sub?.currentPeriodStart.toISOString(), '2027-03-01T00:00:00.000Z');
    assert.equal(sub.currentPeriodEnd.toISOString(), '2027-04-01T00:00:00.000Z');
  });

  it('trocar de plano durante o ciclo pago fica para a etapa de troca (PLAN_CHANGE_UNAVAILABLE)', async () => {
    const { s, account } = await activate('change');
    await assert.rejects(
      s.service.createOrder(account, { ...ESSENTIAL_AGENDA, planCode: 'PROFESSIONAL' }),
      (error: unknown) =>
        error instanceof ConflictError && error.code === 'PLAN_CHANGE_UNAVAILABLE',
    );
  });
});

describe('reconciliação periódica (spec 031, E3)', () => {
  it('concede o pedido pago cujo webhook nunca chegou, expira o vencido não pago e não toca em outra conta', async () => {
    const s = stack();
    // Estado limpo: nenhum pedido pendente antigo destes testes para atrapalhar a contagem.
    await clearOpenOrders();
    // A janela de 48 h da reconciliação usa o created_at do banco: este teste usa o relógio real como base.
    clock = new Date();
    const a = await accountWithTrial('rec-a');
    const b = await accountWithTrial('rec-b');
    const paid = await s.service.createOrder(a.account, ESSENTIAL_AGENDA);
    const unpaid = await s.service.createOrder(b.account, ESSENTIAL_AGENDA);
    fake.markPaid(paid.orderId, { amount: paid.amountCents });

    clock = new Date(clock.getTime() + 2 * 3_600_000);
    let summary = await s.reconciler.runOnce();
    assert.equal(summary.paid, 1);
    assert.equal((await checkoutRepo.findOrder(a.account.id, paid.orderId))?.status, 'PAID');
    assert.equal((await checkoutRepo.findOrder(b.account.id, unpaid.orderId))?.status, 'PENDING');

    // Não reconsulta o que acabou de ser conferido (marca last_checked_at).
    const calls = fake.callsTo('/payment_check').length;
    summary = await s.reconciler.runOnce();
    assert.equal(summary.checked, 0);
    assert.equal(fake.callsTo('/payment_check').length, calls);

    // Depois do prazo do pedido e do intervalo mínimo, o não pago expira.
    const fresh = await s.service.createOrder(b.account, ESSENTIAL_AGENDA);
    clock = new Date(clock.getTime() + 25 * 3_600_000);
    summary = await s.reconciler.runOnce();
    assert.equal(summary.expired, 1);
    assert.equal((await checkoutRepo.findOrder(b.account.id, fresh.orderId))?.status, 'EXPIRED');
  });

  it('respeita o teto por execução e para sozinha quando a credencial é recusada', async () => {
    const good = stack();
    const bad = stack({ apiKey: 'inchk_chave_errada_0000' });
    await clearOpenOrders();
    const accounts = await Promise.all(
      ['cap1', 'cap2', 'cap3'].map((label) => accountWithTrial(label)),
    );
    for (const { account } of accounts) await good.service.createOrder(account, ESSENTIAL_AGENDA);
    clock = new Date(clock.getTime() + 3_600_000);
    const summary = await bad.reconciler.runOnce();
    // Credencial errada: a primeira consulta já interrompe a execução e nada é concedido.
    assert.equal(summary.stoppedEarly, true);
    assert.equal(summary.checked, 1);
    assert.equal(summary.paid, 0);
  });

  it('claimForReconciliation não entrega o mesmo pedido a duas execuções simultâneas', async () => {
    await clearOpenOrders();
    const s = stack();
    const accounts = await Promise.all(
      ['sk1', 'sk2', 'sk3', 'sk4'].map((label) => accountWithTrial(label)),
    );
    for (const { account } of accounts) await s.service.createOrder(account, ESSENTIAL_AGENDA);
    const stale = new Date(clock.getTime() - 60_000);
    const [x, y] = await Promise.all([
      checkoutRepo.claimForReconciliation(clock, stale, 25),
      checkoutRepo.claimForReconciliation(clock, stale, 25),
    ]);
    assert.equal(x.length + y.length, 4);
    assert.equal(new Set([...x, ...y]).size, 4);
  });
});

describe('reativação da IA depois do pagamento (spec 031, E3)', () => {
  it('reagenda o flush das mensagens pendentes só das empresas da assinatura paga', async () => {
    const s = stack();
    const a = await accountWithTrial('resume-a');
    const b = await accountWithTrial('resume-b');
    const phoneA = `99${randomBytes(5).toString('hex').replace(/[a-f]/g, '1')}`.slice(0, 14);
    const phoneB = `98${randomBytes(5).toString('hex').replace(/[a-f]/g, '2')}`.slice(0, 14);
    const companyA = await tenants.createCompany('resume-a', phoneA);
    const companyB = await tenants.createCompany('resume-b', phoneB);
    await db().company.updateMany({
      where: { id: companyA.id },
      data: { subscriptionId: a.subscription.id },
    });
    await db().company.updateMany({
      where: { id: companyB.id },
      data: { subscriptionId: b.subscription.id },
    });
    for (const [company, contact] of [
      [companyA.id, 'contato-a-pendente'],
      [companyA.id, 'contato-a-respondido'],
      [companyB.id, 'contato-b-pendente'],
    ] as const) {
      const conversation = await db().conversation.create({
        data: { companyId: company, contactRef: contact },
      });
      const message = await db().message.create({
        data: {
          companyId: company,
          conversationId: conversation.id,
          role: 'USER',
          content: 'oi',
          externalId: `ext-${randomBytes(4).toString('hex')}`,
        },
      });
      if (contact === 'contato-a-respondido') {
        const reply = await db().message.create({
          data: {
            companyId: company,
            conversationId: conversation.id,
            role: 'ASSISTANT',
            content: 'olá',
            replyToId: message.id,
          },
        });
        await db().message.updateMany({
          where: { id: message.id, companyId: company },
          data: { answeredById: reply.id },
        });
      }
    }

    const created = await s.service.createOrder(a.account, ESSENTIAL_AGENDA);
    fake.markPaid(created.orderId, { amount: created.amountCents });
    assert.equal(await s.verifier.verify(created.orderId), 'paid');

    await s.verifier.drain();
    assert.equal(s.flushes.length, 1);
    const flush = s.flushes[0];
    assert.equal(flush?.job.companyId, companyA.id);
    assert.equal(flush.job.contactRef, 'contato-a-pendente');
    assert.equal(flush.job.phoneNumberId, phoneA);
    assert.deepEqual(flush.schedule, { delayMs: 0, mode: 'ensure' });
    // O log do reagendamento tem só contagens e ids, nunca o contato.
    assert.equal(s.logs.raw().includes('contato-a-pendente'), false);
  });
});

describe('revisão da E3: cooldown, deduplicação, teto, reconciliação e criação concorrente', () => {
  it('I3: cooldown por pedido: a segunda consulta logo depois é descartada sem chamar o provedor e volta depois do intervalo', async () => {
    const s = stack({ cooldownMs: 10_000 });
    const { account } = await accountWithTrial('cooldown');
    const created = await s.service.createOrder(account, ESSENTIAL_AGENDA);
    const base = fake.callsTo('/payment_check').length;
    assert.equal(await s.verifier.verify(created.orderId), 'not_paid');
    assert.equal(await s.verifier.verify(created.orderId), 'cooldown');
    assert.equal(await s.verifier.verify(created.orderId), 'cooldown');
    assert.equal(fake.callsTo('/payment_check').length, base + 1);
    clock = new Date(clock.getTime() + 11_000);
    assert.equal(await s.verifier.verify(created.orderId), 'not_paid');
    assert.equal(fake.callsTo('/payment_check').length, base + 2);
    // "Já paguei" também respeita o cooldown (e a reconciliação, que já reivindicou, não o aplica de novo).
    const again = await s.service.checkOrder(account.id, created.orderId);
    assert.equal(again.result, 'cooldown');
    assert.equal(await s.verifier.verify(created.orderId, {}, { skipCooldown: true }), 'not_paid');
  });

  it('I3: confirmação em segundo plano duplicada para o mesmo pedido é ignorada enquanto há tarefa', async () => {
    const s = stack();
    const { account } = await accountWithTrial('dedup');
    const created = await s.service.createOrder(account, ESSENTIAL_AGENDA);
    fake.failChecks({ kind: 'slow', ms: 250 });
    const base = fake.callsTo('/payment_check').length;
    assert.equal(s.verifier.verifyInBackground(created.orderId, {}), 'started');
    assert.equal(s.verifier.verifyInBackground(created.orderId, {}), 'duplicate');
    assert.equal(
      await s.service.acceptWebhook(created.orderId, tokenFor(created.orderId), {
        orderNsu: created.orderId,
        transactionNsu: undefined,
        invoiceSlug: undefined,
      }),
      'duplicate',
    );
    await s.verifier.drain();
    // Motivo: uma só consulta para as três tentativas de disparar a confirmação.
    assert.equal(fake.callsTo('/payment_check').length, base + 1);
    // Terminada a tarefa, uma nova é aceita.
    fake.failChecks(undefined);
    assert.equal(s.verifier.verifyInBackground(created.orderId, {}), 'started');
    await s.verifier.drain();
  });

  it('I3: teto de confirmações simultâneas em segundo plano', async () => {
    const s = stack({ maxBackground: 2 });
    const orders: string[] = [];
    for (const label of ['cap-a', 'cap-b', 'cap-c']) {
      const { account } = await accountWithTrial(label);
      orders.push((await s.service.createOrder(account, ESSENTIAL_AGENDA)).orderId);
    }
    fake.failChecks({ kind: 'slow', ms: 250 });
    const started = orders.map((id) => s.verifier.verifyInBackground(id, {}));
    assert.deepEqual(started, ['started', 'started', 'capacity']);
    await s.verifier.drain();
    fake.failChecks(undefined);
  });

  it('S2: o Retry-After do provedor entra no backoff do segundo plano, limitado a 30 s', async () => {
    const s = stack();
    const { account } = await accountWithTrial('retry-after');
    const created = await s.service.createOrder(account, ESSENTIAL_AGENDA);
    fake.failChecks({ kind: 'status', status: 429, retryAfter: '20' }, 1);
    fake.failChecks({ kind: 'status', status: 429, retryAfter: '999' }, 1);
    // Duas falhas com esperas diferentes: configura em sequência pelo próprio servidor falso.
    sleeps.length = 0;
    fake.failChecks({ kind: 'status', status: 429, retryAfter: '20' }, 2);
    s.verifier.verifyInBackground(created.orderId, {});
    await s.verifier.drain();
    assert.deepEqual(sleeps, [20_000, 20_000]);
    sleeps.length = 0;
    fake.failChecks({ kind: 'status', status: 429, retryAfter: '999' }, 2);
    s.verifier.verifyInBackground(created.orderId, {});
    await s.verifier.drain();
    assert.deepEqual(sleeps, [30_000, 30_000]);
  });

  it('I4: a reconciliação também confere o pedido EXPIRED por substituição que tem link', async () => {
    const s = stack();
    await clearOpenOrders();
    clock = new Date();
    const { account } = await accountWithTrial('rec-expired');
    const first = await s.service.createOrder(account, ESSENTIAL_AGENDA);
    await s.service.createOrder(account, ESSENTIAL_AGENDA);
    assert.equal((await checkoutRepo.findOrder(account.id, first.orderId))?.status, 'EXPIRED');
    fake.markPaid(first.orderId, { amount: first.amountCents });
    clock = new Date(clock.getTime() + 3_600_000);
    const summary = await s.reconciler.runOnce();
    assert.equal(summary.paid, 1);
    assert.equal((await checkoutRepo.findOrder(account.id, first.orderId))?.status, 'PAID');
  });

  it('S3: criações simultâneas respeitam o teto de pedidos (contagem sob a trava da assinatura)', async () => {
    const s = stack();
    clock = new Date();
    const { account } = await accountWithTrial('create-race');
    const results = await Promise.allSettled(
      Array.from({ length: ORDER_MAX_PER_DAY + 8 }, () =>
        s.service.createOrder(account, ESSENTIAL_AGENDA),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    // Motivo na asserção: sem a trava, a contagem lida por todas daria mais de ORDER_MAX_PER_DAY pedidos.
    assert.equal(ok, ORDER_MAX_PER_DAY, `criados: ${String(ok)}`);
    for (const r of results) {
      if (r.status === 'rejected') {
        assert.equal((r.reason as { code?: string }).code, 'ORDER_LIMIT_REACHED');
      }
    }
    assert.equal((await billing.listOrders(account.id, 50)).length, ORDER_MAX_PER_DAY);
  });

  it('S1: por padrão nenhum dado do pagador (e-mail) vai ao provedor', async () => {
    const s = stack();
    const { account } = await accountWithTrial('no-email');
    await s.service.createOrder(account, ESSENTIAL_AGENDA);
    const body = fake.callsTo('/links').at(-1)?.body ?? {};
    assert.equal('customer' in body, false);
    assert.equal(JSON.stringify(body).includes(account.email), false);
  });

  it('o orderId e o token do webhook nunca aparecem em log', async () => {
    const s = stack();
    const { account } = await accountWithTrial('no-id-log');
    const created = await s.service.createOrder(account, ESSENTIAL_AGENDA);
    fake.markPaid(created.orderId, { amount: created.amountCents });
    await s.service.acceptWebhook(created.orderId, tokenFor(created.orderId), {
      orderNsu: created.orderId,
      transactionNsu: undefined,
      invoiceSlug: undefined,
    });
    await s.verifier.drain();
    const raw = s.logs.raw();
    assert.equal(raw.includes(created.orderId), false);
    assert.equal(raw.includes(tokenFor(created.orderId)), false);
  });
});

describe('privacidade (spec 031, E3)', () => {
  it('a API Key, o e-mail, o link e o recibo ecoados pelo provedor nunca vão a log, métrica nem erro', async () => {
    const s = stack();
    const { account } = await accountWithTrial('privacy');
    fake.failLinks({ kind: 'echo' });
    let thrown: unknown;
    try {
      await s.service.createOrder(account, ESSENTIAL_AGENDA);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof Error);
    const serializedError = JSON.stringify({
      message: thrown.message,
      code: (thrown as { code?: string }).code,
      context: (thrown as { context?: unknown }).context,
    });
    fake.failLinks(undefined);
    const created = await s.service.createOrder(account, ESSENTIAL_AGENDA);
    fake.markPaid(created.orderId, { amount: created.amountCents });
    fake.failChecks({ kind: 'echo' });
    await s.verifier.verify(created.orderId);
    fake.failChecks(undefined);
    await s.service.acceptWebhook(created.orderId, tokenFor(created.orderId), {
      orderNsu: created.orderId,
      transactionNsu: 'tx-secreta-123',
      invoiceSlug: 'slug-secreto-123',
    });
    await s.verifier.drain();
    const everything = [s.logs.raw(), await s.metrics.render(), serializedError].join('\n');
    for (const secret of [
      API_KEY,
      account.email,
      EMAIL_SENTINEL,
      'recibo.exemplo',
      'checkout.exemplo',
      created.checkoutUrl,
      'tx-secreta-123',
      'slug-secreto-123',
    ]) {
      assert.equal(everything.includes(secret), false, `vazou: ${secret}`);
    }
  });
});
