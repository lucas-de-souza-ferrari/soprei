import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { AccountService } from '../../application/auth/account.service.js';
import type {
  CheckoutService,
  CreatedOrder,
  OrderCheckResult,
  OrderRequest,
  WebhookEvent,
  WebhookOutcome,
} from '../../application/billing/checkout.service.js';
import { buildServer } from '../../infrastructure/http/server.js';
import { createMetrics } from '../../infrastructure/metrics/index.js';
import { NotFoundError, UnauthorizedError } from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import { captureLogs } from '../../test-support/log-capture.js';

const ORIGIN = 'http://localhost:5174';
const SECRET = 'a'.repeat(43);
const ACCOUNT_ID = '01900000-0000-7000-8000-0000000000a1';
const ORDER_ID = '01900000-0000-7000-8000-0000000000b2';
const TOKEN = 'T'.repeat(43);
const BROWSER = { cookie: `soprei_session=${SECRET}`, origin: ORIGIN, 'x-soprei-app': 'web' };

class FakeCheckout {
  readonly created: { accountId: string; email: string; request: OrderRequest }[] = [];
  readonly checks: { accountId: string; orderId: string; hints: unknown }[] = [];
  readonly webhooks: { orderId: string; event: WebhookEvent; token: string }[] = [];
  failWebhook = false;
  readonly changes: { method: string; accountId: string; input?: unknown }[] = [];

  quote(accountId: string, input: unknown) {
    this.changes.push({ method: 'quote', accountId, input });
    return Promise.resolve({
      kind: 'UPGRADE' as const,
      amountCents: 9_267,
      effective: 'now' as const,
      periodEnd: new Date('2026-12-10T12:00:00Z'),
      remainingDays: 20,
    });
  }

  upgrade(account: { id: string }, input: unknown): Promise<CreatedOrder> {
    this.changes.push({ method: 'upgrade', accountId: account.id, input });
    return this.createOrder({ id: account.id, email: 'x' }, input as OrderRequest);
  }

  scheduleChange(accountId: string, input: unknown) {
    this.changes.push({ method: 'scheduleChange', accountId, input });
    return Promise.resolve(input);
  }

  undoPendingChange(accountId: string) {
    this.changes.push({ method: 'undoPendingChange', accountId });
    return Promise.resolve();
  }

  cancel(accountId: string) {
    this.changes.push({ method: 'cancel', accountId });
    return Promise.resolve();
  }

  reactivate(accountId: string) {
    this.changes.push({ method: 'reactivate', accountId });
    return Promise.resolve();
  }

  changeState() {
    return Promise.resolve({
      cancelAtPeriodEnd: true,
      pendingChange: null,
      internal: 'nao-deve-sair',
    });
  }

  createOrder(
    account: { id: string; email: string },
    request: OrderRequest,
  ): Promise<CreatedOrder> {
    this.created.push({ accountId: account.id, email: account.email, request });
    return Promise.resolve({
      orderId: ORDER_ID,
      checkoutUrl: 'https://checkout.exemplo.test/x',
      amountCents: 8_800,
      expiresAt: new Date('2026-11-11T12:00:00Z'),
    });
  }

  checkOrder(accountId: string, orderId: string, hints: unknown): Promise<OrderCheckResult> {
    this.checks.push({ accountId, orderId, hints });
    if (orderId !== ORDER_ID) return Promise.reject(new NotFoundError('Pedido não encontrado'));
    return Promise.resolve({
      result: 'unavailable',
      order: {
        id: ORDER_ID,
        subscriptionId: 'sub',
        kind: 'NEW',
        status: 'PENDING',
        amountCents: 8_800,
        breakdown: {
          planCode: 'ESSENTIAL',
          cycle: 'MONTHLY',
          agenda: true,
          stock: false,
          priceId: ORDER_ID,
          priceVersion: 1,
          whatsappBillingMode: 'CUSTOMER_PAYS_META',
        },
        checkoutUrl: 'https://checkout.exemplo.test/x',
        providerTransactionRef: 'tx-segredo',
        providerSlug: null,
        paidAt: null,
        periodStart: null,
        periodEnd: null,
        expiresAt: new Date('2026-11-11T12:00:00Z'),
        createdAt: new Date('2026-11-10T12:00:00Z'),
      },
    });
  }

  acceptWebhook(orderId: string, token: string, event: WebhookEvent): Promise<WebhookOutcome> {
    this.webhooks.push({ orderId, event, token });
    if (this.failWebhook) return Promise.reject(new Error('banco fora'));
    return Promise.resolve('recorded');
  }
}

function start(options: { checkout?: boolean } = {}): {
  app: FastifyInstance;
  checkout: FakeCheckout;
  logs: ReturnType<typeof captureLogs>;
  metrics: ReturnType<typeof createMetrics>;
  routes: { url: string; method: string | string[]; profile: unknown }[];
} {
  const checkout = new FakeCheckout();
  const logs = captureLogs();
  const metrics = createMetrics();
  const accounts = {
    me: (secret: string) =>
      secret === SECRET
        ? Promise.resolve({ id: ACCOUNT_ID, email: 'x@exemplo.test', selectedCompanyId: null })
        : Promise.reject(new UnauthorizedError()),
    tenantIdentity: () => Promise.resolve(null),
    drain: () => Promise.resolve(),
  } as unknown as AccountService;
  const app = buildServer({
    logger: logs.logger,
    metrics,
    readiness: {
      database: () => Promise.resolve(Result.ok(undefined)),
      redis: () => Promise.resolve(Result.ok(undefined)),
    },
    accounts: { service: accounts, origin: ORIGIN, secure: false },
    billing: {
      service: { overview: () => Promise.reject(new Error('n/a')) },
      entitlements: { forCompany: () => Promise.reject(new Error('n/a')) },
      ...(options.checkout === false ? {} : { checkout: checkout as unknown as CheckoutService }),
    },
  });
  const routes: { url: string; method: string | string[]; profile: unknown }[] = [];
  app.addHook('onRoute', (route) => {
    routes.push({
      url: route.url,
      method: route.method,
      profile: (route.config as Record<string, unknown> | undefined)?.rateLimitProfile,
    });
  });
  return { app, checkout, logs, metrics, routes };
}

describe('POST /account/billing/orders (spec 031, E3)', () => {
  it('com CHECKOUT_ENABLED=false as rotas de pedido e o webhook não existem (404) e nada é chamado', async () => {
    const { app, checkout } = start({ checkout: false });
    const order = await app.inject({
      method: 'POST',
      url: '/account/billing/orders',
      headers: BROWSER,
      payload: { planCode: 'ESSENTIAL', cycle: 'MONTHLY', agenda: true, stock: false },
    });
    assert.equal(order.statusCode, 404);
    const check = await app.inject({
      method: 'POST',
      url: `/account/billing/orders/${ORDER_ID}/check`,
      headers: BROWSER,
      payload: {},
    });
    assert.equal(check.statusCode, 404);
    const webhook = await app.inject({
      method: 'POST',
      url: `/webhooks/infinitepay/${ORDER_ID}/${TOKEN}`,
      payload: { order_nsu: ORDER_ID },
    });
    assert.equal(webhook.statusCode, 404);
    assert.equal(checkout.created.length + checkout.checks.length + checkout.webhooks.length, 0);
    await app.close();
  });

  it('exige cookie (401) e a origem do site (403); a conta vem só do cookie', async () => {
    const { app, checkout } = start();
    const payload = { planCode: 'ESSENTIAL', cycle: 'MONTHLY', agenda: true, stock: false };
    const anonymous = await app.inject({
      method: 'POST',
      url: '/account/billing/orders',
      headers: { origin: ORIGIN, 'x-soprei-app': 'web' },
      payload,
    });
    assert.equal(anonymous.statusCode, 401);
    const foreign = await app.inject({
      method: 'POST',
      url: '/account/billing/orders',
      headers: { cookie: BROWSER.cookie, origin: 'https://outro.exemplo' },
      payload,
    });
    assert.equal(foreign.statusCode, 403);
    assert.equal(checkout.created.length, 0);

    const ok = await app.inject({
      method: 'POST',
      url: `/account/billing/orders?accountId=01900000-0000-7000-8000-0000000000ff`,
      headers: BROWSER,
      payload,
    });
    assert.equal(ok.statusCode, 201);
    assert.equal(ok.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(ok.body), {
      orderId: ORDER_ID,
      checkoutUrl: 'https://checkout.exemplo.test/x',
      amountCents: 8_800,
      expiresAt: '2026-11-11T12:00:00.000Z',
    });
    assert.deepEqual(checkout.created, [
      { accountId: ACCOUNT_ID, email: 'x@exemplo.test', request: payload },
    ]);
    await app.close();
  });

  it('o corpo é strict: valor, desconto, período, id e plano desconhecido são recusados (400) e nada é criado', async () => {
    const { app, checkout } = start();
    const base = { planCode: 'ESSENTIAL', cycle: 'MONTHLY', agenda: true, stock: false };
    for (const extra of [
      { amountCents: 1 },
      { amount: 1 },
      { discount: 50 },
      { periodEnd: '2099-01-01T00:00:00Z' },
      { accountId: ACCOUNT_ID },
      { subscriptionId: ORDER_ID },
      { price: 1 },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/account/billing/orders',
        headers: BROWSER,
        payload: { ...base, ...extra },
      });
      assert.equal(response.statusCode, 400, JSON.stringify(extra));
    }
    for (const bad of [
      { ...base, planCode: 'GRATIS' },
      { ...base, cycle: 'WEEKLY' },
      { ...base, agenda: 'sim' },
      { planCode: 'ESSENTIAL' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/account/billing/orders',
        headers: BROWSER,
        payload: bad,
      });
      assert.equal(response.statusCode, 400);
    }
    assert.equal(checkout.created.length, 0);
    await app.close();
  });

  it('"Já paguei": só a conta do cookie, referências do retorno validadas, 404 uniforme e resposta sem dado do provedor', async () => {
    const { app, checkout } = start();
    const url = `/account/billing/orders/${ORDER_ID}/check`;
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { origin: ORIGIN, 'x-soprei-app': 'web' },
          payload: {},
        })
      ).statusCode,
      401,
    );
    const ok = await app.inject({
      method: 'POST',
      url,
      headers: BROWSER,
      payload: { transactionNsu: 'tx-1', slug: 'slug-1' },
    });
    assert.equal(ok.statusCode, 200);
    const body = JSON.parse(ok.body) as { outcome: string; order: Record<string, unknown> };
    // "unavailable" é erro de configuração ou de rede: o site só sabe que não deu para confirmar.
    assert.equal(body.outcome, 'unavailable');
    assert.deepEqual(Object.keys(body.order).sort(), [
      'amountCents',
      'createdAt',
      'id',
      'kind',
      'paidAt',
      'status',
    ]);
    assert.equal(ok.body.includes('tx-segredo'), false);
    assert.deepEqual(checkout.checks[0], {
      accountId: ACCOUNT_ID,
      orderId: ORDER_ID,
      hints: { transactionNsu: 'tx-1', slug: 'slug-1' },
    });
    // Corpo vazio vale como sem referências; referência malformada ou campo desconhecido é 400.
    assert.equal(
      (await app.inject({ method: 'POST', url, headers: BROWSER, payload: {} })).statusCode,
      200,
    );
    for (const bad of [{ slug: '../..' }, { transactionNsu: 'x'.repeat(200) }, { extra: 1 }]) {
      assert.equal(
        (await app.inject({ method: 'POST', url, headers: BROWSER, payload: bad })).statusCode,
        400,
      );
    }
    const other = await app.inject({
      method: 'POST',
      url: '/account/billing/orders/01900000-0000-7000-8000-0000000000cc/check',
      headers: BROWSER,
      payload: {},
    });
    assert.equal(other.statusCode, 404);
    await app.close();
  });
});

describe('POST /webhooks/infinitepay/:orderId (spec 031, E3)', () => {
  it('grava só as referências do corpo e responde 200 sem confiar no resto (valores, recibo, pagador)', async () => {
    const { app, checkout, logs } = start();
    const response = await app.inject({
      method: 'POST',
      url: `/webhooks/infinitepay/${ORDER_ID}/${TOKEN}`,
      payload: {
        order_nsu: ORDER_ID,
        transaction_nsu: 'tx-77',
        invoice_slug: 'slug-77',
        amount: 1,
        paid_amount: 1,
        receipt_url: 'https://recibo-secreto.exemplo/r',
        customer: { email: 'pagador-secreto@exemplo.test', phone_number: '+5511999990000' },
      },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(checkout.webhooks, [
      {
        orderId: ORDER_ID,
        token: TOKEN,
        event: { orderNsu: ORDER_ID, transactionNsu: 'tx-77', invoiceSlug: 'slug-77' },
      },
    ]);
    const raw = logs.raw();
    for (const secret of ['recibo-secreto', 'pagador-secreto', '5511999990000', 'tx-77']) {
      assert.equal(raw.includes(secret), false, `vazou ${secret}`);
    }
    await app.close();
  });

  it('id malformado e corpo que não é objeto respondem 200 sem efeito; referência fora do formato vira ausente', async () => {
    const { app, checkout } = start();
    const malformed = await app.inject({
      method: 'POST',
      url: `/webhooks/infinitepay/nao-e-uuid/${TOKEN}`,
      payload: { order_nsu: ORDER_ID },
    });
    assert.equal(malformed.statusCode, 200);
    const array = await app.inject({
      method: 'POST',
      url: `/webhooks/infinitepay/${ORDER_ID}/${TOKEN}`,
      payload: [1, 2, 3],
    });
    assert.equal(array.statusCode, 200);
    assert.equal(checkout.webhooks.length, 0);
    const weird = await app.inject({
      method: 'POST',
      url: `/webhooks/infinitepay/${ORDER_ID}/${TOKEN}`,
      payload: { transaction_nsu: 'tem espaço <script>', invoice_slug: 12 },
    });
    assert.equal(weird.statusCode, 200);
    assert.deepEqual(checkout.webhooks[0]?.event, {
      orderNsu: undefined,
      transactionNsu: undefined,
      invoiceSlug: undefined,
    });
    await app.close();
  });

  it('token malformado responde 200 sem efeito e o orderId e o token nunca vão a log', async () => {
    const { app, checkout, logs } = start();
    checkout.failWebhook = true;
    const bad = await app.inject({
      method: 'POST',
      url: `/webhooks/infinitepay/${ORDER_ID}/curto`,
      payload: { order_nsu: ORDER_ID },
    });
    assert.equal(bad.statusCode, 200);
    assert.equal(checkout.webhooks.length, 0);
    // A falha ao gravar também não loga o id nem o token.
    const failed = await app.inject({
      method: 'POST',
      url: `/webhooks/infinitepay/${ORDER_ID}/${TOKEN}`,
      payload: { order_nsu: ORDER_ID },
    });
    assert.equal(failed.statusCode, 400);
    assert.equal(logs.raw().includes(ORDER_ID), false);
    assert.equal(logs.raw().includes(TOKEN), false);
    await app.close();
  });

  it('corpo acima de 16 KiB é recusado (413) sem processar', async () => {
    const { app, checkout } = start();
    const response = await app.inject({
      method: 'POST',
      url: `/webhooks/infinitepay/${ORDER_ID}/${TOKEN}`,
      payload: { order_nsu: ORDER_ID, items: 'x'.repeat(17 * 1024) },
    });
    assert.equal(response.statusCode, 413);
    assert.equal(checkout.webhooks.length, 0);
    await app.close();
  });

  it('falha ao gravar responde 400 (a InfinitePay repete), conta a métrica e não vaza o erro', async () => {
    const { app, checkout, metrics, logs } = start();
    checkout.failWebhook = true;
    const response = await app.inject({
      method: 'POST',
      url: `/webhooks/infinitepay/${ORDER_ID}/${TOKEN}`,
      payload: { order_nsu: ORDER_ID, transaction_nsu: 'tx-1' },
    });
    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body) as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'WEBHOOK_RETRY');
    assert.equal(response.body.includes('banco fora'), false);
    assert.match(await metrics.render(), /billing_webhooks_total\{result="error"\} 1/);
    assert.equal(logs.raw().includes('banco fora'), false);
    await app.close();
  });

  it('as rotas novas declaram o perfil de rate limit (webhook para o webhook, admin para o pedido)', async () => {
    const { app, routes } = start();
    await app.ready();
    const profile = (url: string): unknown => routes.find((route) => route.url === url)?.profile;
    assert.equal(profile('/webhooks/infinitepay/:orderId/:token'), 'webhook');
    assert.equal(profile('/account/billing/orders'), 'admin');
    assert.equal(profile('/account/billing/orders/:orderId/check'), 'admin');
    await app.close();
  });
});

describe('troca de plano, cotação, cancelar e reativar (spec 031, D11)', () => {
  const UP = { action: 'upgrade', planCode: 'PROFESSIONAL', agenda: true, stock: false };

  it('com a flag desligada as rotas novas não existem (404)', async () => {
    const { app, checkout } = start({ checkout: false });
    const post = await app.inject({
      method: 'POST',
      url: '/account/billing/plan-change',
      headers: BROWSER,
      payload: UP,
    });
    const get = await app.inject({
      method: 'GET',
      url: '/account/billing/quote?planCode=SCALE&agenda=true&stock=true',
      headers: { cookie: BROWSER.cookie },
    });
    assert.equal(post.statusCode, 404);
    assert.equal(get.statusCode, 404);
    assert.equal(checkout.changes.length, 0);
    await app.close();
  });

  it('exige cookie (401) e a origem do site (403); a conta vem só do cookie', async () => {
    const { app, checkout } = start();
    const anonymous = await app.inject({
      method: 'POST',
      url: '/account/billing/plan-change',
      headers: { origin: ORIGIN, 'x-soprei-app': 'web' },
      payload: UP,
    });
    assert.equal(anonymous.statusCode, 401);
    const foreign = await app.inject({
      method: 'POST',
      url: '/account/billing/plan-change',
      headers: { cookie: BROWSER.cookie, origin: 'https://outro.exemplo' },
      payload: UP,
    });
    assert.equal(foreign.statusCode, 403);
    const quoteAnonymous = await app.inject({
      method: 'GET',
      url: '/account/billing/quote?planCode=SCALE&agenda=true&stock=true',
    });
    assert.equal(quoteAnonymous.statusCode, 401);
    assert.equal(checkout.changes.length, 0);
    await app.close();
  });

  it('o corpo é strict por ação: valor, conta, pedido e campos fora da ação são recusados (400)', async () => {
    const { app, checkout } = start();
    for (const payload of [
      { ...UP, amountCents: 1 },
      { ...UP, accountId: ACCOUNT_ID },
      { ...UP, cycle: 'ANNUAL' },
      { action: 'cancel', planCode: 'SCALE' },
      { action: 'reactivate', extra: 1 },
      { action: 'undo_pending', extra: 1 },
      { action: 'refund' },
      { action: 'upgrade', planCode: 'GRATIS', agenda: true, stock: false },
      { action: 'downgrade', planCode: 'ESSENTIAL', agenda: 'sim', stock: false },
      {},
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/account/billing/plan-change',
        headers: BROWSER,
        payload,
      });
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
    }
    assert.equal(checkout.changes.length, 0);
    await app.close();
  });

  it('cada ação chama o serviço com a conta do cookie e devolve só o estado público (sem dinheiro de outros)', async () => {
    const { app, checkout } = start();
    const post = (payload: object) =>
      app.inject({
        method: 'POST',
        url: '/account/billing/plan-change?accountId=01900000-0000-7000-8000-0000000000ff',
        headers: BROWSER,
        payload,
      });
    const upgrade = await post(UP);
    assert.equal(upgrade.statusCode, 201);
    assert.equal((JSON.parse(upgrade.body) as { amountCents: number }).amountCents, 8_800);
    const down = await post({
      action: 'downgrade',
      planCode: 'ESSENTIAL',
      agenda: false,
      stock: false,
      cycle: 'ANNUAL',
    });
    assert.equal(down.statusCode, 200);
    assert.deepEqual(JSON.parse(down.body), { cancelAtPeriodEnd: true, pendingChange: null });
    for (const action of ['cancel', 'reactivate', 'undo_pending']) {
      assert.equal((await post({ action })).statusCode, 200);
    }
    assert.deepEqual(
      checkout.changes.map((c) => [c.method, c.accountId]),
      [
        ['upgrade', ACCOUNT_ID],
        ['scheduleChange', ACCOUNT_ID],
        ['cancel', ACCOUNT_ID],
        ['reactivate', ACCOUNT_ID],
        ['undoPendingChange', ACCOUNT_ID],
      ],
    );
    await app.close();
  });

  it('GET quote: valida a query, usa a conta do cookie e não cria pedido', async () => {
    const { app, checkout } = start();
    const ok = await app.inject({
      method: 'GET',
      url: '/account/billing/quote?planCode=PROFESSIONAL&agenda=true&stock=false',
      headers: { cookie: BROWSER.cookie },
    });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(JSON.parse(ok.body), {
      kind: 'UPGRADE',
      amountCents: 9_267,
      effective: 'now',
      periodEnd: '2026-12-10T12:00:00.000Z',
      remainingDays: 20,
    });
    for (const query of [
      'planCode=GRATIS&agenda=true&stock=false',
      'planCode=SCALE&agenda=sim&stock=false',
      'planCode=SCALE&agenda=true',
      'planCode=SCALE&agenda=true&stock=false&amountCents=1',
    ]) {
      const bad = await app.inject({
        method: 'GET',
        url: '/account/billing/quote?' + query,
        headers: { cookie: BROWSER.cookie },
      });
      assert.equal(bad.statusCode, 400, query);
    }
    assert.deepEqual(
      checkout.changes.map((c) => c.method),
      ['quote'],
    );
    assert.equal(checkout.created.length, 0);
    await app.close();
  });

  it('as rotas de troca declaram o perfil admin', async () => {
    const { app, routes } = start();
    await app.ready();
    const profile = (url: string): unknown => routes.find((route) => route.url === url)?.profile;
    assert.equal(profile('/account/billing/plan-change'), 'admin');
    assert.equal(profile('/account/billing/quote'), 'admin');
    await app.close();
  });
});
