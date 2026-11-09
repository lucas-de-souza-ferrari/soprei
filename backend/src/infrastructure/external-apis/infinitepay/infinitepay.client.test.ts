import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { SecretString } from '../../../shared/types/index.js';
import { FakeInfinitepayApi } from '../../../test-support/fake-infinitepay-api.js';
import { InfinitepayClient } from './infinitepay.client.js';

const API_KEY = 'inchk_chave_de_teste_0123456789';
const ORDER = '01900000-0000-7000-8000-0000000000b2';
const VALID_UNTIL = new Date('2026-11-11T12:00:00Z');

let fake: FakeInfinitepayApi;

function client(options: { apiKey?: string; timeoutMs?: number; baseUrl?: string } = {}) {
  return new InfinitepayClient({
    baseUrl: options.baseUrl ?? fake.baseUrl,
    apiKey: new SecretString(options.apiKey ?? API_KEY),
    handle: 'loja-teste',
    timeoutMs: options.timeoutMs ?? 2_000,
  });
}

const LINK_INPUT = {
  orderId: ORDER,
  amountCents: 8_800,
  description: 'Soprei Essencial mensal + Agenda',
  customerEmail: 'pagador@exemplo.test',
  redirectUrl: 'https://site.exemplo.test/painel/assinatura',
  webhookUrl: `https://api.exemplo.test/webhooks/infinitepay/${ORDER}`,
  validUntil: VALID_UNTIL,
} as const;

before(async () => {
  fake = new FakeInfinitepayApi(API_KEY);
  await fake.start();
});
after(async () => {
  await fake.stop();
});
beforeEach(() => {
  fake.failLinks(undefined);
  fake.failChecks(undefined);
  fake.setLinkResponse(undefined);
});

describe('InfinitepayClient.createLink (spec 031, E3)', () => {
  it('manda o pedido do catálogo com X-Api-Key e devolve a url', async () => {
    const result = await client().createLink(LINK_INPUT);
    assert.ok(result.ok);
    assert.match(result.value.url, /\/pay\//);
    const call = fake.calls.at(-1);
    assert.equal(call?.path, '/links');
    assert.equal(call.apiKey, API_KEY);
    assert.equal(call.body.order_nsu, ORDER);
    assert.deepEqual(call.body.customer, { email: 'pagador@exemplo.test' });
  });

  it('sem e-mail não manda pagador algum', async () => {
    const result = await client().createLink({
      orderId: ORDER,
      amountCents: 8_800,
      description: 'x',
      redirectUrl: LINK_INPUT.redirectUrl,
      webhookUrl: LINK_INPUT.webhookUrl,
      validUntil: VALID_UNTIL,
    });
    assert.ok(result.ok);
    assert.equal('customer' in (fake.calls.at(-1)?.body ?? {}), false);
  });

  it('401 e 403 são erro de configuração; 429 respeita Retry-After (limitado); 5xx e queda são transitórios; outro 4xx é recusa', async () => {
    const wrong = await client({ apiKey: 'chave-errada' }).createLink(LINK_INPUT);
    assert.ok(!wrong.ok);
    assert.equal(wrong.error.reason, 'config');
    assert.equal(wrong.error.httpStatus, 403);
    assert.equal(wrong.error.retryable, false);

    fake.failLinks({ kind: 'status', status: 401 });
    const unauthorized = await client().createLink(LINK_INPUT);
    assert.ok(!unauthorized.ok);
    assert.equal(unauthorized.error.reason, 'config');

    fake.failLinks({ kind: 'status', status: 429, retryAfter: '3' });
    const limited = await client().createLink(LINK_INPUT);
    assert.ok(!limited.ok);
    assert.equal(limited.error.reason, 'rate_limited');
    assert.equal(limited.error.retryAfterMs, 3_000);
    assert.equal(limited.error.retryable, true);

    fake.failLinks({ kind: 'status', status: 429, retryAfter: '999999' });
    const capped = await client().createLink(LINK_INPUT);
    assert.ok(!capped.ok);
    assert.equal(capped.error.retryAfterMs, 60_000);

    fake.failLinks({ kind: 'status', status: 503 });
    const down = await client().createLink(LINK_INPUT);
    assert.ok(!down.ok);
    assert.equal(down.error.reason, 'transient');

    fake.failLinks({ kind: 'drop' });
    const dropped = await client().createLink(LINK_INPUT);
    assert.ok(!dropped.ok);
    assert.equal(dropped.error.reason, 'transient');

    fake.failLinks({ kind: 'status', status: 422 });
    const rejected = await client().createLink(LINK_INPUT);
    assert.ok(!rejected.ok);
    assert.equal(rejected.error.reason, 'rejected');
    assert.equal(rejected.error.retryable, false);
  });

  it('prazo estourado vira falha transitória', async () => {
    fake.failLinks({ kind: 'slow', ms: 500 });
    const result = await client({ timeoutMs: 80 }).createLink(LINK_INPUT);
    assert.ok(!result.ok);
    assert.equal(result.error.reason, 'transient');
  });

  it('o erro leva só operação, motivo, status e se é retentável; o servidor que ecoa chave, corpo e link não vaza nada', async () => {
    fake.failLinks({ kind: 'echo' });
    const result = await client().createLink(LINK_INPUT);
    assert.ok(!result.ok);
    const serialized = JSON.stringify({
      message: result.error.message,
      code: result.error.code,
      context: result.error.context,
      own: JSON.stringify(result.error),
    });
    for (const secret of [API_KEY, 'pagador@exemplo.test', 'recibo.exemplo', 'checkout.exemplo']) {
      assert.equal(serialized.includes(secret), false, `vazou ${secret}`);
    }
    assert.deepEqual(result.error.context, {
      operation: 'create_link',
      reason: 'transient',
      retryable: true,
      httpStatus: 500,
    });
  });

  it('link malicioso ou resposta fora do formato é recusado', async () => {
    for (const body of [
      { url: 'javascript:alert(1)' },
      { url: 'data:text/html,<script>1</script>' },
      { url: 'não é url' },
      { outro: 'campo' },
      'texto',
      [],
    ]) {
      fake.setLinkResponse(body);
      const result = await client().createLink(LINK_INPUT);
      assert.ok(!result.ok, JSON.stringify(body));
      assert.equal(result.error.reason, 'invalid_response');
    }
  });

  it('com a base https o link http é recusado e o https passa (http só quando a própria base é http)', async () => {
    const respond =
      (url: string): typeof fetch =>
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ url }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
    const make = (url: string) =>
      new InfinitepayClient({
        baseUrl: 'https://api.checkout.infinitepay.io',
        apiKey: new SecretString(API_KEY),
        handle: 'loja-teste',
        timeoutMs: 1_000,
        fetch: respond(url),
      });
    const insecure = await make('http://checkout.exemplo/x').createLink(LINK_INPUT);
    assert.ok(!insecure.ok);
    assert.equal(insecure.error.reason, 'invalid_response');
    const secure = await make('https://checkout.exemplo/x').createLink(LINK_INPUT);
    assert.ok(secure.ok);
  });
});

describe('InfinitepayClient.checkPayment (spec 031, E3)', () => {
  it('SEMPRE manda X-Api-Key e as referências; pago com o valor do link', async () => {
    fake.markPaid(ORDER, { amount: 8_800, paidAmount: 9_160, captureMethod: 'credit_card' });
    const result = await client().checkPayment({
      orderId: ORDER,
      transactionNsu: 'tx-1',
      slug: 'slug-1',
    });
    assert.ok(result.ok);
    assert.deepEqual(result.value, {
      paid: true,
      amountCents: 8_800,
      paidAmountCents: 9_160,
      captureMethod: 'credit_card',
    });
    const call = fake.calls.at(-1);
    assert.equal(call?.path, '/payment_check');
    assert.equal(call.apiKey, API_KEY);
    assert.deepEqual(call.body, {
      handle: 'loja-teste',
      order_nsu: ORDER,
      transaction_nsu: 'tx-1',
      slug: 'slug-1',
    });
  });

  it('não pago e referências ausentes (só handle e order_nsu)', async () => {
    const result = await client().checkPayment({ orderId: '01900000-0000-7000-8000-0000000000e9' });
    assert.ok(result.ok);
    assert.equal(result.value.paid, false);
    assert.deepEqual(Object.keys(fake.calls.at(-1)?.body ?? {}).sort(), ['handle', 'order_nsu']);
  });

  it('success false ou paid ausente nunca conta como pago', async () => {
    fake.markPaid(ORDER, { amount: 100 });
    const result = await client().checkPayment({ orderId: ORDER });
    assert.ok(result.ok && result.value.paid);
    const other = await client().checkPayment({ orderId: 'outro' });
    assert.ok(other.ok && !other.value.paid);
  });

  it('403 e 401 são erro de configuração (não "não pago"); 429 e 5xx são transitórios', async () => {
    const wrong = await client({ apiKey: 'chave-errada' }).checkPayment({ orderId: ORDER });
    assert.ok(!wrong.ok);
    assert.equal(wrong.error.reason, 'config');
    fake.failChecks({ kind: 'status', status: 401 });
    const unauthorized = await client().checkPayment({ orderId: ORDER });
    assert.ok(!unauthorized.ok);
    assert.equal(unauthorized.error.reason, 'config');
    fake.failChecks({ kind: 'status', status: 429 });
    const limited = await client().checkPayment({ orderId: ORDER });
    assert.ok(!limited.ok);
    assert.equal(limited.error.reason, 'rate_limited');
    fake.failChecks({ kind: 'status', status: 500 });
    const down = await client().checkPayment({ orderId: ORDER });
    assert.ok(!down.ok);
    assert.equal(down.error.reason, 'transient');
  });

  it('o corpo de erro que ecoa tudo não aparece no erro', async () => {
    fake.failChecks({ kind: 'echo' });
    const result = await client().checkPayment({ orderId: ORDER, transactionNsu: 'tx-9' });
    assert.ok(!result.ok);
    const serialized = JSON.stringify(result.error) + result.error.message;
    for (const secret of [API_KEY, 'recibo.exemplo', 'tx-9']) {
      assert.equal(serialized.includes(secret), false, `vazou ${secret}`);
    }
  });
});
