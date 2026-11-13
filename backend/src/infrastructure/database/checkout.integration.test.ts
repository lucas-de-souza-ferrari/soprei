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
const SETTINGS = { graceDays: GRACE, trialDays: 7, trialTokens: 300_000, trialReplies: 100 };

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
// Essencial mensal (R$ 47,90, catálogo da spec 040) + Agenda (R$ 29,00).
const ESSENTIAL_AGENDA_CENTS = 4_790 + 2_900;

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
    assert.equal(created.amountCents, 11_990 + 4_900);
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
    assert.equal(created.amountCents, 47_900 + 29_000);
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

  it('B1: o provedor real responde 200 {"success":false} sem as referências: a segunda tentativa com elas concede', async () => {
    const s = stack();
    const { account } = await accountWithTrial('silent');
    const created = await s.service.createOrder(account, ESSENTIAL_AGENDA);
    fake.markPaid(created.orderId, { amount: created.amountCents });
    fake.requireRefs(true, 'silent');
    try {
      const before = fake.callsTo('/payment_check').length;
      assert.equal(
        await s.verifier.verify(created.orderId, {
          transactionNsu: 'tx-silent',
          slug: 'slug-silent',
        }),
        'paid',
      );
      const calls = fake.callsTo('/payment_check').slice(before);
      assert.equal(calls.length, 2);
      assert.deepEqual(Object.keys(calls[0]?.body ?? {}).sort(), ['handle', 'order_nsu']);
      assert.equal(calls[1]?.body.transaction_nsu, 'tx-silent');
    } finally {
      fake.requireRefs(false);
    }
  });

  it('B1: o provedor responde "não pago" sem as referências e elas não vieram: not_paid, sem segunda chamada', async () => {
    const s = stack();
    const { account } = await accountWithTrial('silent-norefs');
    const created = await s.service.createOrder(account, ESSENTIAL_AGENDA);
    fake.markPaid(created.orderId, { amount: created.amountCents });
    fake.requireRefs(true, 'silent');
    try {
      const before = fake.callsTo('/payment_check').length;
      assert.equal(await s.verifier.verify(created.orderId), 'not_paid');
      assert.equal(fake.callsTo('/payment_check').length - before, 1);
    } finally {
      fake.requireRefs(false);
    }
    assert.equal((await checkoutRepo.findOrder(account.id, created.orderId))?.status, 'PENDING');
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

  it('trocar de plano durante o ciclo pago pelo pedido comum é recusado (USE_PLAN_CHANGE)', async () => {
    const { s, account } = await activate('change');
    await assert.rejects(
      s.service.createOrder(account, { ...ESSENTIAL_AGENDA, planCode: 'PROFESSIONAL' }),
      (error: unknown) => error instanceof ConflictError && error.code === 'USE_PLAN_CHANGE',
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

describe('troca de plano no meio do ciclo, cancelar e reativar (spec 031, D11)', () => {
  const ESSENTIAL_PLAIN = {
    planCode: 'ESSENTIAL',
    cycle: 'MONTHLY',
    agenda: false,
    stock: false,
  } as const;
  const PRO_AGENDA = { planCode: 'PROFESSIONAL', agenda: true, stock: false } as const;

  /** Assina o Essencial mensal sem módulos, pago em t0, e devolve o necessário para trocar. */
  type OrderRequestLike = {
    planCode: 'ESSENTIAL' | 'PROFESSIONAL' | 'SCALE';
    cycle: 'MONTHLY' | 'ANNUAL';
    agenda: boolean;
    stock: boolean;
  };
  async function activated(label: string, selection: OrderRequestLike = ESSENTIAL_PLAIN) {
    const s = stack();
    clock = new Date('2026-11-10T12:00:00Z');
    const { account, subscription } = await accountWithTrial(label);
    const first = await s.service.createOrder(account, selection);
    fake.markPaid(first.orderId, { amount: first.amountCents });
    assert.equal(await s.verifier.verify(first.orderId), 'paid');
    return { s, account, subscription };
  }

  const state = (accountId: string) => billing.findSubscription(accountId);

  it('cotação e pedido de upgrade: diferença proporcional só do servidor; o pagamento vale na hora, o fim do período não muda e o uso permanece', async () => {
    const { s, account, subscription } = await activated('up-basic');
    const before = await state(account.id);
    assert.equal(before?.currentPeriodEnd.toISOString(), '2026-12-10T12:00:00.000Z');
    await db().usageCounter.updateMany({
      where: { subscriptionId: subscription.id },
      data: { tokens: 777n, sentMessages: 5n },
    });
    clock = new Date('2026-11-20T12:00:00Z'); // restam 20 dos 30 dias

    // Essencial (R$ 47,90) -> Profissional + Agenda (R$ 119,90 + R$ 49): diferença 12.100 x 20/30 = 8.066,67 -> 8.067.
    const quote = await s.service.quote(account.id, PRO_AGENDA);
    assert.equal(quote.kind, 'UPGRADE');
    assert.equal(quote.amountCents, 8_067);
    assert.equal(quote.effective, 'now');
    assert.equal(quote.remainingDays, 20);
    // Cotar não cria pedido.
    assert.equal(
      await db().paymentOrder.count({
        where: { subscriptionId: subscription.id, kind: 'UPGRADE' },
      }),
      0,
    );

    const created = await s.service.upgrade(account, PRO_AGENDA);
    assert.equal(created.amountCents, 8_067);
    const order = await checkoutRepo.findOrder(account.id, created.orderId);
    assert.equal(order?.kind, 'UPGRADE');
    assert.equal(order.breakdown.upgradeBase?.planCode, 'ESSENTIAL');
    assert.equal(order.breakdown.upgradeBase.periodEnd, '2026-12-10T12:00:00.000Z');
    const link = fake.callsTo('/links').at(-1)?.body as { items: { price: number }[] };
    assert.equal(link.items[0]?.price, 8_067);

    fake.markPaid(created.orderId, { amount: 8_067 });
    assert.equal(await s.verifier.verify(created.orderId), 'paid');
    const after = await state(account.id);
    assert.equal(after?.plan.code, 'PROFESSIONAL');
    assert.equal(after.agendaEnabled, true);
    assert.equal(after.stockEnabled, false);
    assert.equal(after.cycle, 'MONTHLY');
    assert.equal(after.status, 'ACTIVE');
    // O fim e o início do período NÃO mudam; o uso já contado permanece e a cota é a do plano novo.
    assert.equal(after.currentPeriodStart.toISOString(), before.currentPeriodStart.toISOString());
    assert.equal(after.currentPeriodEnd.toISOString(), '2026-12-10T12:00:00.000Z');
    const usage = await billing.usage(account.id, after.currentPeriodStart);
    assert.equal(usage.tokens, 777);
    assert.equal(usage.sentMessages, 5);
    assert.equal(after.plan.monthlyTokens, 48_000_000);
    const paid = await checkoutRepo.findOrder(account.id, created.orderId);
    assert.equal(paid?.periodEnd?.toISOString(), '2026-12-10T12:00:00.000Z');
  });

  it('idempotência e concorrência: 10 confirmações do mesmo upgrade em paralelo concedem uma só vez', async () => {
    const { s, account } = await activated('up-race');
    clock = new Date('2026-11-15T12:00:00Z');
    const created = await s.service.upgrade(account, PRO_AGENDA);
    fake.markPaid(created.orderId, { amount: created.amountCents });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => s.verifier.verify(created.orderId)),
    );
    assert.equal(results.filter((r) => r === 'paid').length, 1, `resultados: ${results.join(',')}`);
    const after = await state(account.id);
    assert.equal(after?.plan.code, 'PROFESSIONAL');
    assert.equal(after.currentPeriodEnd.toISOString(), '2026-12-10T12:00:00.000Z');
  });

  it('só um UPGRADE aberto por assinatura: o novo substitui o anterior', async () => {
    const { s, account } = await activated('up-one');
    clock = new Date('2026-11-15T12:00:00Z');
    const first = await s.service.upgrade(account, PRO_AGENDA);
    const second = await s.service.upgrade(account, { ...PRO_AGENDA, stock: true });
    assert.equal((await checkoutRepo.findOrder(account.id, first.orderId))?.status, 'EXPIRED');
    assert.equal((await checkoutRepo.findOrder(account.id, second.orderId))?.status, 'PENDING');
  });

  it('período renovado entre criar e pagar o upgrade: não concede, o pedido vira FAILED, conta a métrica e o plano não muda', async () => {
    const { s, account } = await activated('up-stale');
    clock = new Date('2026-11-15T12:00:00Z');
    const upgrade = await s.service.upgrade(account, PRO_AGENDA);
    // A renovação do mesmo plano é paga antes (o período passa a terminar em janeiro).
    const renewal = await s.service.createOrder(account, ESSENTIAL_PLAIN);
    fake.markPaid(renewal.orderId, { amount: renewal.amountCents });
    assert.equal(await s.verifier.verify(renewal.orderId), 'paid');
    assert.equal(
      (await state(account.id))?.currentPeriodEnd.toISOString(),
      '2027-01-10T12:00:00.000Z',
    );

    fake.markPaid(upgrade.orderId, { amount: upgrade.amountCents });
    assert.equal(await s.verifier.verify(upgrade.orderId), 'upgrade_stale');
    const after = await state(account.id);
    assert.equal(after?.plan.code, 'ESSENTIAL');
    assert.equal(after.agendaEnabled, false);
    assert.equal(after.currentPeriodEnd.toISOString(), '2027-01-10T12:00:00.000Z');
    assert.equal((await checkoutRepo.findOrder(account.id, upgrade.orderId))?.status, 'FAILED');
    assert.match(
      await s.metrics.render(),
      /billing_orders_total\{kind="UPGRADE",result="upgrade_stale"\} 1/,
    );
    assert.ok(s.logs.lines().some((line) => line.level === 50));
    // Já FAILED: confirmar de novo não faz nada.
    assert.equal(await s.verifier.verify(upgrade.orderId), 'ignored');
  });

  it('módulo contratado por outro caminho entre criar e pagar também invalida o upgrade', async () => {
    const { s, account, subscription } = await activated('up-stale2');
    clock = new Date('2026-11-15T12:00:00Z');
    const upgrade = await s.service.upgrade(account, PRO_AGENDA);
    await db().subscription.updateMany({
      where: { id: subscription.id },
      data: { stockEnabled: true },
    });
    fake.markPaid(upgrade.orderId, { amount: upgrade.amountCents });
    assert.equal(await s.verifier.verify(upgrade.orderId), 'upgrade_stale');
    assert.equal((await state(account.id))?.plan.code, 'ESSENTIAL');
  });

  it('recusas do upgrade: tarde demais, ciclo, não é upgrade, troca agendada, cancelada, trial e carência', async () => {
    const { s, account } = await activated('up-refuse');
    const code = (promise: Promise<unknown>) =>
      promise.then(
        () => 'ok',
        (error: unknown) => (error as { code?: string }).code,
      );
    clock = new Date('2026-12-10T00:00:00Z'); // faltam 12 h
    assert.equal(await code(s.service.upgrade(account, PRO_AGENDA)), 'UPGRADE_TOO_LATE');
    clock = new Date('2026-11-15T12:00:00Z');
    assert.equal(
      await code(s.service.upgrade(account, { ...PRO_AGENDA, cycle: 'ANNUAL' })),
      'CYCLE_CHANGE_ON_RENEWAL',
    );
    assert.equal(await code(s.service.upgrade(account, ESSENTIAL_PLAIN)), 'NOT_AN_UPGRADE');
    await s.service.cancel(account.id);
    assert.equal(await code(s.service.upgrade(account, PRO_AGENDA)), 'PLAN_CHANGE_UNAVAILABLE');
    await s.service.reactivate(account.id);
    await db().subscription.updateMany({
      where: { accountId: account.id },
      data: {
        pendingChange: { planCode: 'ESSENTIAL', cycle: 'ANNUAL', agenda: false, stock: false },
      },
    });
    assert.equal(await code(s.service.upgrade(account, PRO_AGENDA)), 'PENDING_CHANGE_EXISTS');
    await s.service.undoPendingChange(account.id);
    // Na carência (fim + 1 dia): renovar, não fazer upgrade.
    clock = new Date('2026-12-11T12:00:00Z');
    assert.equal(await code(s.service.upgrade(account, PRO_AGENDA)), 'PLAN_CHANGE_UNAVAILABLE');
    // Teste gratuito: escolhe-se o plano ao assinar.
    const trial = await accountWithTrial('up-refuse-trial');
    assert.equal(
      await code(s.service.upgrade(trial.account, PRO_AGENDA)),
      'PLAN_CHANGE_UNAVAILABLE',
    );
  });

  it('downgrade e retirada de módulo só gravam a troca agendada: nada muda agora e nenhum pedido é criado', async () => {
    const { s, account, subscription } = await activated('down-basic', {
      ...ESSENTIAL_PLAIN,
      agenda: true,
    });
    const before = await state(account.id);
    const orders = await db().paymentOrder.count({ where: { subscriptionId: subscription.id } });
    clock = new Date('2026-11-15T12:00:00Z');
    const quote = await s.service.quote(account.id, ESSENTIAL_PLAIN);
    assert.equal(quote.kind, 'DOWNGRADE');
    assert.equal(quote.amountCents, 0);
    assert.equal(quote.effective, 'next_renewal');
    const change = await s.service.scheduleChange(account.id, ESSENTIAL_PLAIN);
    assert.deepEqual(change, ESSENTIAL_PLAIN);
    const after = await state(account.id);
    assert.deepEqual(after?.pendingChange, ESSENTIAL_PLAIN);
    // Nada mudou agora.
    assert.equal(after.agendaEnabled, true);
    assert.equal(after.currentPeriodEnd.toISOString(), before?.currentPeriodEnd.toISOString());
    assert.equal(
      await db().paymentOrder.count({ where: { subscriptionId: subscription.id } }),
      orders,
    );
    // Desfazer antes da renovação.
    await s.service.undoPendingChange(account.id);
    assert.equal((await state(account.id))?.pendingChange, null);
  });

  it('a renovação usa o preço do plano pendente e aplica a troca; renovar o atual com troca agendada é recusado', async () => {
    const { s, account } = await activated('down-renew', { ...ESSENTIAL_PLAIN, agenda: true });
    clock = new Date('2026-12-01T12:00:00Z');
    await s.service.scheduleChange(account.id, ESSENTIAL_PLAIN);
    const code = (promise: Promise<unknown>) =>
      promise.then(
        () => 'ok',
        (error: unknown) => (error as { code?: string }).code,
      );
    assert.equal(
      await code(s.service.createOrder(account, { ...ESSENTIAL_PLAIN, agenda: true })),
      'PENDING_CHANGE_EXISTS',
    );
    assert.equal(
      await code(s.service.createOrder(account, { ...ESSENTIAL_PLAIN, planCode: 'SCALE' })),
      'USE_PLAN_CHANGE',
    );
    const renewal = await s.service.createOrder(account, ESSENTIAL_PLAIN);
    assert.equal(renewal.amountCents, 4_790);
    assert.equal((await checkoutRepo.findOrder(account.id, renewal.orderId))?.kind, 'RENEWAL');
    fake.markPaid(renewal.orderId, { amount: 4_790 });
    assert.equal(await s.verifier.verify(renewal.orderId), 'paid');
    const after = await state(account.id);
    assert.equal(after?.agendaEnabled, false);
    assert.equal(after.pendingChange, null);
    assert.equal(after.currentPeriodEnd.toISOString(), '2027-01-10T12:00:00.000Z');
  });

  it('downgrade bloqueado por número de empresas (inclusive as não adotadas) e reconferido na renovação', async () => {
    const { s, account, subscription } = await activated('down-block', {
      planCode: 'PROFESSIONAL',
      cycle: 'MONTHLY',
      agenda: false,
      stock: false,
    });
    const code = (promise: Promise<unknown>) =>
      promise.then(
        () => 'ok',
        (error: unknown) => (error as { code?: string }).code,
      );
    clock = new Date('2026-11-15T12:00:00Z');
    const adopted = await tenants.createCompany('blk1');
    await db().company.updateMany({
      where: { id: adopted.id },
      data: { subscriptionId: subscription.id },
    });
    // Uma segunda empresa ainda NÃO adotada (sem assinatura), em que a conta é OWNER ativa.
    const loose = await tenants.createCompany('blk2');
    await db().membership.create({
      data: {
        companyId: loose.id,
        email: account.email,
        passwordHash: 'account-managed',
        role: 'OWNER',
        status: 'ACTIVE',
        accountId: account.id,
      },
    });
    assert.equal(await billing.countCompanies(account.id), 1);
    assert.equal(await billing.countCompaniesIncludingUnadopted(account.id), 2);
    assert.equal(
      await code(s.service.scheduleChange(account.id, { ...ESSENTIAL_PLAIN })),
      'PLAN_DOWNGRADE_BLOCKED',
    );
    assert.equal((await state(account.id))?.pendingChange, null);

    // Reconferência na renovação: troca agendada válida (2 empresas cabem no Profissional ... para o mesmo
    // plano sem módulos não há troca; usa o Escala -> Profissional abaixo), depois as empresas passam do limite.
    await db().company.updateMany({
      where: { id: loose.id },
      data: { deletedAt: new Date() },
    });
    await s.service.scheduleChange(account.id, ESSENTIAL_PLAIN); // 1 empresa cabe no Essencial
    const renewal = await s.service.createOrder(account, ESSENTIAL_PLAIN);
    // A conta ganha uma 2ª empresa depois de gerado o pedido: a concessão NÃO aplica a troca.
    const another = await tenants.createCompany('blk3');
    await db().company.updateMany({
      where: { id: another.id },
      data: { subscriptionId: subscription.id },
    });
    fake.markPaid(renewal.orderId, { amount: renewal.amountCents });
    assert.equal(await s.verifier.verify(renewal.orderId), 'renewal_stale');
    assert.equal((await state(account.id))?.plan.code, 'PROFESSIONAL');
    // E novos pedidos para o plano pequeno são recusados na criação.
    assert.equal(
      await code(s.service.createOrder(account, ESSENTIAL_PLAIN)),
      'PLAN_DOWNGRADE_BLOCKED',
    );
  });

  it('cancelar marca o fim do período (segue ativa e renovável) e reativar desmarca; depois de expirada não há o que cancelar', async () => {
    const { s, account } = await activated('cancel');
    clock = new Date('2026-11-15T12:00:00Z');
    await s.service.cancel(account.id);
    await s.service.cancel(account.id); // idempotente
    let sub = await state(account.id);
    assert.equal(sub?.cancelAtPeriodEnd, true);
    assert.equal(sub.status, 'ACTIVE');
    assert.equal(sub.currentPeriodEnd.toISOString(), '2026-12-10T12:00:00.000Z');
    // Segue com acesso até o fim e vira EXPIRED depois (sem carência).
    const { resolveAccess } = await import('../../domain/index.js');
    assert.equal(resolveAccess(sub, clock, GRACE).state, 'CANCELLED');
    assert.equal(resolveAccess(sub, new Date('2026-12-10T12:00:01Z'), GRACE).state, 'EXPIRED');
    await s.service.reactivate(account.id);
    sub = await state(account.id);
    assert.equal(sub?.cancelAtPeriodEnd, false);
    // Renovar paga e também limpa a marca.
    await s.service.cancel(account.id);
    const renewal = await s.service.createOrder(account, ESSENTIAL_PLAIN);
    fake.markPaid(renewal.orderId, { amount: renewal.amountCents });
    assert.equal(await s.verifier.verify(renewal.orderId), 'paid');
    assert.equal((await state(account.id))?.cancelAtPeriodEnd, false);
    // Depois de expirada (fim + carência) cancelar/reativar não se aplicam: é um pedido normal.
    clock = new Date('2027-03-01T00:00:00Z');
    // Uma ação por vez: criadas juntas, a segunda promessa rejeitava antes de alguém a observar e o
    // runner a tratava como rejeição não capturada (falha intermitente).
    for (const action of [
      () => s.service.cancel(account.id),
      () => s.service.reactivate(account.id),
    ]) {
      await assert.rejects(
        action(),
        (error: unknown) => (error as { code?: string }).code === 'PLAN_CHANGE_UNAVAILABLE',
      );
    }
  });

  it('isolamento: a ação de uma conta nunca toca a assinatura de outra; sem assinatura é NO_SUBSCRIPTION', async () => {
    const a = await activated('iso-a');
    const b = await activated('iso-b');
    const none = await newAccount('iso-none');
    clock = new Date('2026-11-15T12:00:00Z');
    await a.s.service.cancel(a.account.id);
    await a.s.service.scheduleChange(a.account.id, { ...ESSENTIAL_PLAIN, cycle: 'ANNUAL' });
    const bState = await state(b.account.id);
    assert.equal(bState?.cancelAtPeriodEnd, false);
    assert.equal(bState.pendingChange, null);
    for (const act of [
      () => a.s.service.cancel(none.id),
      () => a.s.service.reactivate(none.id),
      () => a.s.service.undoPendingChange(none.id),
      () => a.s.service.upgrade(none, PRO_AGENDA),
      () => a.s.service.quote(none.id, PRO_AGENDA),
    ]) {
      await assert.rejects(
        act(),
        (error: unknown) => (error as { code?: string }).code === 'NO_SUBSCRIPTION',
      );
    }
    assert.equal(await checkoutRepo.setCancelAtPeriodEnd(none.id, true), false);
    assert.equal(await checkoutRepo.setPendingChange(none.id, null), false);
  });

  it('privacidade: nenhuma operação de troca vaza e-mail, id de pedido ou valores em log e as métricas são de conjunto fixo', async () => {
    const { s, account } = await activated('priv-change');
    clock = new Date('2026-11-15T12:00:00Z');
    await s.service.quote(account.id, PRO_AGENDA);
    const created = await s.service.upgrade(account, PRO_AGENDA);
    await s.service.cancel(account.id);
    await s.service.reactivate(account.id);
    const raw = s.logs.raw() + (await s.metrics.render());
    for (const secret of [account.email, EMAIL_SENTINEL, created.orderId, created.checkoutUrl]) {
      assert.equal(raw.includes(secret), false, `vazou ${secret}`);
    }
  });
});

describe('segunda revisão da E3: cooldown do webhook, renovação obsoleta e referências do provedor', () => {
  const ESS = { planCode: 'ESSENTIAL', cycle: 'MONTHLY', agenda: false, stock: false } as const;
  const PRO_AGENDA = { planCode: 'PROFESSIONAL', agenda: true, stock: false } as const;

  async function activeEssential(label: string) {
    const s = stack({ cooldownMs: 10_000 });
    clock = new Date('2026-11-10T12:00:00Z');
    const { account } = await accountWithTrial(label);
    const first = await s.service.createOrder(account, ESS);
    fake.markPaid(first.orderId, { amount: first.amountCents });
    assert.equal(await s.verifier.verify(first.orderId, {}, { skipCooldown: true }), 'paid');
    return { s, account };
  }

  it('I1: o webhook logo depois de um "Já paguei" com not_paid (atraso do provedor) concede e não é descartado pelo cooldown', async () => {
    const s = stack({ cooldownMs: 10_000 });
    const { account } = await accountWithTrial('webhook-cooldown');
    const created = await s.service.createOrder(account, ESS);
    // O provedor ainda não refletia o pagamento: "Já paguei" dá not_paid e abre o cooldown.
    const early = await s.service.checkOrder(account.id, created.orderId);
    assert.equal(early.result, 'not_paid');
    assert.equal((await s.service.checkOrder(account.id, created.orderId)).result, 'cooldown');
    // 3 s depois o provedor confirma e o webhook definitivo chega: não pode ser descartado.
    clock = new Date(clock.getTime() + 3_000);
    fake.markPaid(created.orderId, { amount: created.amountCents });
    assert.equal(
      await s.service.acceptWebhook(created.orderId, tokenFor(created.orderId), {
        orderNsu: created.orderId,
        transactionNsu: undefined,
        invoiceSlug: undefined,
      }),
      'recorded',
    );
    await s.verifier.drain();
    assert.equal((await checkoutRepo.findOrder(account.id, created.orderId))?.status, 'PAID');
  });

  it('I2a: renovação aberta no plano menor, upgrade pago, depois a renovação paga: não desfaz o upgrade e vai para revisão (renewal_stale)', async () => {
    const { s, account } = await activeEssential('renewal-stale');
    clock = new Date('2026-11-15T12:00:00Z');
    const renewal = await s.service.createOrder(account, ESS);
    const upgrade = await s.service.upgrade(account, PRO_AGENDA);
    // (b) criar o upgrade expira as renovações abertas.
    assert.equal((await checkoutRepo.findOrder(account.id, renewal.orderId))?.status, 'EXPIRED');
    fake.markPaid(upgrade.orderId, { amount: upgrade.amountCents });
    assert.equal(await s.verifier.verify(upgrade.orderId, {}, { skipCooldown: true }), 'paid');

    fake.markPaid(renewal.orderId, { amount: renewal.amountCents });
    assert.equal(
      await s.verifier.verify(renewal.orderId, {}, { skipCooldown: true }),
      'renewal_stale',
    );
    const sub = await billing.findSubscription(account.id);
    assert.equal(sub?.plan.code, 'PROFESSIONAL');
    assert.equal(sub.agendaEnabled, true);
    assert.equal(sub.currentPeriodEnd.toISOString(), '2026-12-10T12:00:00.000Z');
    assert.equal((await checkoutRepo.findOrder(account.id, renewal.orderId))?.status, 'FAILED');
    const metrics = await s.metrics.render();
    assert.match(metrics, /billing_orders_total\{kind="RENEWAL",result="renewal_stale"\} 1/);
    assert.doesNotMatch(metrics, /kind="RENEWAL",result="upgrade_stale"/);
  });

  it('I2d: renovação aberta e troca agendada depois: a renovação do plano atual concede e a troca agendada NÃO é apagada', async () => {
    const { s, account } = await activeEssential('renewal-keeps-pending');
    clock = new Date('2026-11-15T12:00:00Z');
    const renewal = await s.service.createOrder(account, { ...ESS, agenda: false });
    // Troca agendada para o plano SCALE só de agenda... (qualquer troca diferente do plano do pedido).
    const pending = {
      planCode: 'ESSENTIAL',
      cycle: 'ANNUAL',
      agenda: false,
      stock: false,
    } as const;
    await s.service.scheduleChange(account.id, pending);
    assert.equal((await checkoutRepo.findOrder(account.id, renewal.orderId))?.status, 'EXPIRED');
    fake.markPaid(renewal.orderId, { amount: renewal.amountCents });
    assert.equal(await s.verifier.verify(renewal.orderId, {}, { skipCooldown: true }), 'paid');
    const sub = await billing.findSubscription(account.id);
    assert.deepEqual(sub?.pendingChange, pending);
    assert.equal(sub.currentPeriodEnd.toISOString(), '2027-01-10T12:00:00.000Z');
  });

  it('S8: concessão de renovação e agendamento de troca em paralelo nunca apagam a troca agendada', async () => {
    const { s, account } = await activeEssential('race-pending');
    clock = new Date('2026-11-15T12:00:00Z');
    const renewal = await s.service.createOrder(account, ESS);
    fake.markPaid(renewal.orderId, { amount: renewal.amountCents });
    const pending = {
      planCode: 'ESSENTIAL',
      cycle: 'ANNUAL',
      agenda: false,
      stock: false,
    } as const;
    await Promise.all([
      s.verifier.verify(renewal.orderId, {}, { skipCooldown: true }),
      checkoutRepo.setPendingChange(account.id, pending),
    ]);
    // Motivo: a renovação aplicou o plano atual, não a troca agendada; esta tem de sobreviver em qualquer ordem.
    assert.deepEqual((await billing.findSubscription(account.id))?.pendingChange, pending);
  });

  it('S3: a cotação de mudança de ciclo tem o rótulo próprio (CYCLE_CHANGE)', async () => {
    const { s, account } = await activeEssential('quote-cycle');
    clock = new Date('2026-11-15T12:00:00Z');
    const quote = await s.service.quote(account.id, { ...ESS, cycle: 'ANNUAL' });
    assert.equal(quote.kind, 'CYCLE_CHANGE');
    assert.equal(quote.effective, 'next_renewal');
    assert.equal(quote.amountCents, 0);
  });

  it('S6: só a referência que o PROVEDOR devolve é gravada; a dica do corpo do webhook ou do navegador nunca', async () => {
    const s = stack();
    const { account } = await accountWithTrial('provider-refs');
    const created = await s.service.createOrder(account, ESS);
    fake.markPaid(created.orderId, { amount: created.amountCents });
    fake.requireRefs(true);
    fake.echoRefs(false);
    try {
      assert.equal(
        await s.verifier.verify(created.orderId, { transactionNsu: 'dica', slug: 'dica' }),
        'paid',
      );
    } finally {
      fake.requireRefs(false);
      fake.echoRefs(true);
    }
    const order = await checkoutRepo.findOrder(account.id, created.orderId);
    assert.equal(order?.status, 'PAID');
    assert.equal(order.providerTransactionRef, null);
    assert.equal(order.providerSlug, null);
  });

  it('S2: link com host inesperado é recusado com motivo próprio no log, sem expor o link nem a chave', async () => {
    const s = stack();
    const { account } = await accountWithTrial('detail');
    fake.setLinkResponse({ url: 'https://atacante.exemplo/segredo-do-link' });
    await assert.rejects(s.service.createOrder(account, ESS));
    const warn = s.logs.lines().find((line) => line.detail !== undefined);
    assert.equal(warn?.detail, 'unexpected_host');
    assert.equal(s.logs.raw().includes('atacante.exemplo'), false);
    assert.equal(s.logs.raw().includes(API_KEY), false);
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

describe('transição para o catálogo novo (spec 040, D4 e D5)', () => {
  const ESSENTIAL_MONTHLY = {
    planCode: 'ESSENTIAL',
    cycle: 'MONTHLY',
    agenda: false,
    stock: false,
  } as const;

  /** Assinatura paga do Essencial mensal, presa à linha ANTIGA do catálogo (versão 1: R$ 59,00, 800 respostas). */
  async function oldSubscriber(label: string) {
    const s = stack();
    clock = new Date('2026-11-10T12:00:00Z');
    const { account, subscription } = await accountWithTrial(label);
    const oldPlan = await db().plan.findFirst({ where: { code: 'ESSENTIAL', version: 1 } });
    assert.ok(oldPlan !== null);
    const oldPrice = await db().planPrice.findFirst({
      where: { planId: oldPlan.id, cycle: 'MONTHLY', version: 1 },
    });
    assert.ok(oldPrice !== null);
    assert.equal(oldPrice.baseCents, 5_900);
    await db().subscription.updateMany({
      where: { id: subscription.id },
      data: {
        planId: oldPlan.id,
        priceId: oldPrice.id,
        status: 'ACTIVE',
        trialEndsAt: null,
        agendaEnabled: false,
        stockEnabled: false,
        currentPeriodStart: new Date('2026-11-10T12:00:00Z'),
        currentPeriodEnd: new Date('2026-12-10T12:00:00Z'),
      },
    });
    return { s, account, subscriptionId: subscription.id, oldPlan, oldPrice };
  }

  it('RENEWAL criado no catálogo antigo (R$ 59,00) e pago depois grava a linha antiga, e a cota continua 2.500', async () => {
    const { s, account, subscriptionId, oldPlan, oldPrice } = await oldSubscriber('old-renewal');
    clock = new Date('2026-12-05T12:00:00Z');
    // O pedido como o código anterior o criava: preço e versão do catálogo antigo no detalhamento.
    const order = await db().paymentOrder.create({
      data: {
        subscriptionId,
        kind: 'RENEWAL',
        status: 'PENDING',
        amountCents: 5_900,
        breakdown: {
          ...ESSENTIAL_MONTHLY,
          priceId: oldPrice.id,
          priceVersion: oldPrice.version,
          whatsappBillingMode: 'CUSTOMER_PAYS_META',
        },
        checkoutUrl: 'https://127.0.0.1/pay/antigo',
        expiresAt: new Date(clock.getTime() + DAY),
      },
    });
    fake.markPaid(order.id, { amount: 5_900 });
    assert.equal(await s.verifier.verify(order.id), 'paid');

    const row = await db().subscription.findFirst({ where: { id: subscriptionId } });
    assert.equal(row?.planId, oldPlan.id, 'a concessão grava a linha do pedido (a antiga)');
    assert.equal(row.priceId, oldPrice.id);
    assert.equal(row.currentPeriodEnd.toISOString(), '2027-01-10T12:00:00.000Z');
    const after = await billing.findSubscription(account.id);
    assert.equal(after?.plan.monthlyReplies, 2_500, 'regra do máximo: não volta à cota antiga');
    assert.equal(after.plan.monthlyTokens, 15_000_000);

    // Um pedido criado agora cobra o catálogo novo: R$ 47,90.
    const next = await s.service.createOrder(account, ESSENTIAL_MONTHLY);
    assert.equal(next.amountCents, 4_790);
    const created = await checkoutRepo.findOrder(account.id, next.orderId);
    assert.equal(created?.kind, 'RENEWAL');
    assert.equal(created.amountCents, 4_790);
  });

  it('renovação do Essencial mensal de quem assina o antigo: cotação e pedido de 4.790, e o período pago em curso não muda', async () => {
    const { s, account, subscriptionId } = await oldSubscriber('old-quote');
    clock = new Date('2026-12-01T12:00:00Z');
    const quote = await s.service.quote(account.id, ESSENTIAL_MONTHLY);
    assert.equal(quote.kind, 'RENEWAL');
    assert.equal(quote.amountCents, 4_790);
    const renewal = await s.service.createOrder(account, ESSENTIAL_MONTHLY);
    assert.equal(renewal.amountCents, 4_790);
    // Cotar e criar o pedido não mexem no período pago (nem no preço gravado na assinatura).
    const pending = await db().subscription.findFirst({ where: { id: subscriptionId } });
    assert.equal(pending?.currentPeriodEnd.toISOString(), '2026-12-10T12:00:00.000Z');
    fake.markPaid(renewal.orderId, { amount: 4_790 });
    assert.equal(await s.verifier.verify(renewal.orderId), 'paid');
    const after = await billing.findSubscription(account.id);
    assert.equal(after?.price.baseCents, 4_790, 'a renovação passa ao preço novo');
    assert.equal(after.plan.version > 1, true, 'e à linha nova do plano');
    assert.equal(after.plan.monthlyReplies, 2_500);
    // O período soma a partir do fim do atual (renovação antecipada), sem reembolso proporcional.
    assert.equal(after.currentPeriodStart.toISOString(), '2026-11-10T12:00:00.000Z');
    assert.equal(after.currentPeriodEnd.toISOString(), '2027-01-10T12:00:00.000Z');
  });
});
