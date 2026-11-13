import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { AccountService } from '../../application/auth/account.service.js';
import { deriveSalesContactKey, issueFormToken } from '../../application/contact/form-token.js';
import { SALES_CONTACT_MAIL_SUBJECT } from '../../application/contact/sales-contact-mail.js';
import {
  SALES_CONTACT_ACCEPTED,
  SalesContactService,
  salesContactRecipient,
} from '../../application/contact/sales-contact.service.js';
import type {
  SalesContactDailyCap,
  SalesContactMail,
  SalesContactMailer,
} from '../../application/ports/sales-contact.js';
import { buildServer } from '../../infrastructure/http/server.js';
import { createMetrics } from '../../infrastructure/metrics/index.js';
import { ServiceUnavailableError } from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import { captureLogs, type LogCapture } from '../../test-support/log-capture.js';

const ORIGIN = 'http://localhost:5174';
const HEADERS = { origin: ORIGIN, 'x-soprei-app': 'web' } as const;
const KEY = deriveSalesContactKey('c'.repeat(48));
const T0 = Date.UTC(2026, 10, 13, 15, 0, 0);
const METRICS_TOKEN = 'm'.repeat(32);
const READY = {
  database: () => Promise.resolve(Result.ok(undefined)),
  redis: () => Promise.resolve(Result.ok(undefined)),
};

// Sentinelas: nenhum pode aparecer em log, métrica nem corpo de erro.
const S = {
  name: 'Sentinela Nome Zq',
  email: 'sentinela.email.zq@empresa.test',
  phone: '+55 11 97777-1234',
  companyName: 'Sentinela Empresa Zq',
  message: 'Sentinela mensagem Zq com texto suficiente.',
  website: 'sentinela-honeypot-zq',
} as const;

class MemoryCap implements SalesContactDailyCap {
  readonly counts = new Map<string, number>();
  down = false;
  take(day: string): Promise<boolean> {
    if (this.down) return Promise.reject(new ServiceUnavailableError('Contato indisponível'));
    const count = (this.counts.get(day) ?? 0) + 1;
    this.counts.set(day, count);
    return Promise.resolve(count <= 30);
  }
}

class FakeMailer implements SalesContactMailer {
  readonly sent: { to: string; mail: SalesContactMail }[] = [];
  fail = false;
  sendSalesContact(to: string, mail: SalesContactMail): Promise<void> {
    if (this.fail) return Promise.reject(new ServiceUnavailableError('smtp'));
    this.sent.push({ to, mail });
    return Promise.resolve();
  }
}

interface World {
  readonly app: FastifyInstance;
  readonly logs: LogCapture;
  readonly mailer: FakeMailer;
  readonly cap: MemoryCap;
  readonly service: SalesContactService;
  setNow(ms: number): void;
  token(ageMs?: number): string;
  post(body: unknown, headers?: Record<string, string>): Promise<LightMyRequestResponse>;
  metricsText(): Promise<string>;
}

function world(recipient = 'vendas@soprei.test'): World {
  let now = T0;
  const logs = captureLogs();
  const mailer = new FakeMailer();
  const cap = new MemoryCap();
  const metrics = createMetrics();
  const service = new SalesContactService({
    mailer,
    cap,
    formKey: KEY,
    recipient,
    logger: logs.logger,
    metrics,
    now: () => new Date(now),
  });
  const app = buildServer({
    logger: logs.logger,
    readiness: READY,
    metrics,
    metricsToken: METRICS_TOKEN,
    accounts: {
      service: { drain: () => Promise.resolve() } as unknown as AccountService,
      origin: ORIGIN,
      secure: false,
      salesContact: service,
    },
  });
  return {
    app,
    logs,
    mailer,
    cap,
    service,
    setNow: (ms) => {
      now = ms;
    },
    token: (ageMs = 10_000) => issueFormToken(KEY, now - ageMs),
    post: (body, headers = HEADERS) =>
      app.inject({ method: 'POST', url: '/contact/sales', payload: body as object, headers }),
    metricsText: async () =>
      (
        await app.inject({
          method: 'GET',
          url: '/metrics',
          headers: { authorization: `Bearer ${METRICS_TOKEN}` },
        })
      ).body,
  };
}

function validBody(w: World, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: S.name,
    email: S.email,
    phone: S.phone,
    companyName: S.companyName,
    units: '31-100',
    monthlyVolume: 'ate-30-mil',
    message: S.message,
    privacyAck: true,
    website: '',
    formToken: w.token(),
    ...overrides,
  };
}

function assertNoSentinel(text: string, where: string, extra: readonly string[] = []): void {
  for (const value of [...Object.values(S), ...extra]) {
    assert.ok(!text.includes(value), `${where} contém ${value}`);
  }
}

async function finish(w: World, extra: readonly string[] = []): Promise<void> {
  await w.service.drain();
  assertNoSentinel(w.logs.raw(), 'log', extra);
  assertNoSentinel(await w.metricsText(), '/metrics', extra);
  await w.app.close();
}

describe('rotas de contato comercial (spec 040, E4)', () => {
  it('sem contas globais (sem salesContact) as duas rotas não existem: 404', async () => {
    const app = buildServer({ logger: captureLogs().logger, readiness: READY });
    try {
      const get = await app.inject({ method: 'GET', url: '/contact/sales/form-token' });
      assert.equal(get.statusCode, 404);
      const post = await app.inject({
        method: 'POST',
        url: '/contact/sales',
        payload: {},
        headers: HEADERS,
      });
      assert.equal(post.statusCode, 404);
    } finally {
      await app.close();
    }
  });

  it('GET form-token: token assinado, no-store, sem ler cookie', async () => {
    const w = world();
    const response = await w.app.inject({
      method: 'GET',
      url: '/contact/sales/form-token',
      headers: { cookie: 'soprei_session=qualquer' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    const { formToken } = response.json<{ formToken: string }>();
    assert.equal(formToken, issueFormToken(KEY, T0));
    await finish(w);
  });

  it('caso válido: 202, exatamente um e-mail com assunto fixo e Reply-To do interessado', async () => {
    const w = world();
    const response = await w.post(validBody(w));
    assert.equal(response.statusCode, 202);
    assert.deepEqual(response.json(), { message: SALES_CONTACT_ACCEPTED });
    assert.equal(response.headers['cache-control'], 'no-store');
    await w.service.drain();
    assert.equal(w.mailer.sent.length, 1);
    const sent = w.mailer.sent[0];
    assert.ok(sent);
    assert.equal(sent.to, 'vendas@soprei.test');
    assert.equal(sent.mail.subject, SALES_CONTACT_MAIL_SUBJECT);
    assert.equal(sent.mail.replyTo, S.email);
    assert.ok(sent.mail.text.includes(`Nome: ${S.name}`));
    assert.ok(sent.mail.text.includes(`Empresa: ${S.companyName}`));
    assert.match(await w.metricsText(), /sales_contact_requests_total\{result="sent"\} 1/);
    await finish(w);
  });

  it('destinatário: SALES_CONTACT_EMAIL quando definido, senão EMAIL_PROVIDER_FROM', () => {
    assert.equal(
      salesContactRecipient({
        SALES_CONTACT_EMAIL: 'vendas@x.test',
        EMAIL_PROVIDER_FROM: 'noreply@x.test',
      }),
      'vendas@x.test',
    );
    assert.equal(
      salesContactRecipient({
        SALES_CONTACT_EMAIL: undefined,
        EMAIL_PROVIDER_FROM: 'noreply@x.test',
      }),
      'noreply@x.test',
    );
  });

  it('sem Origin igual a APP_ORIGIN ou sem X-Soprei-App: web = 403 e nada enviado', async () => {
    const w = world();
    const variants: Record<string, string>[] = [
      {},
      { 'x-soprei-app': 'web' },
      { origin: 'https://evil.test', 'x-soprei-app': 'web' },
      { origin: ORIGIN },
      { origin: ORIGIN, 'x-soprei-app': 'outro' },
    ];
    for (const headers of variants) {
      const response = await w.post(validBody(w), headers);
      assert.equal(response.statusCode, 403, JSON.stringify(headers));
      assertNoSentinel(response.body, 'corpo 403');
    }
    await w.service.drain();
    assert.equal(w.mailer.sent.length, 0);
    await finish(w);
  });

  it('corpo inválido: 400 com mensagem fixa por campo, sem o valor, nada enviado', async () => {
    const w = world();
    const cases: [string, Record<string, unknown>][] = [
      ['campo a mais', { extra: S.name }],
      ['nome curto', { name: 'A' }],
      ['nome longo', { name: 'N'.repeat(101) }],
      ['nome com quebra', { name: `${S.name}\nBcc: x@y.test` }],
      ['nome com Cf', { name: `${S.name}‮` }],
      ['empresa curta', { companyName: 'E' }],
      ['empresa longa', { companyName: 'E'.repeat(121) }],
      ['e-mail inválido', { email: S.name }],
      ['e-mail longo', { email: `${'a'.repeat(250)}@x.test` }],
      ['e-mail com quebra', { email: `${S.email}\r\nBcc: x@y.test` }],
      ['telefone com poucos dígitos', { phone: '1234 567' }],
      ['telefone com dígitos demais', { phone: '1234567890123456' }],
      ['telefone com letras', { phone: `${S.phone}x` }],
      ['telefone longo', { phone: '1'.repeat(21) }],
      ['mensagem curta', { message: 'curta' }],
      ['mensagem longa', { message: 'M'.repeat(2_001) }],
      ['mensagem com 41 linhas', { message: Array.from({ length: 41 }, () => 'linha').join('\n') }],
      ['mensagem com controle', { message: `${S.message}\u0007` }],
      ['units fora do enum', { units: S.companyName }],
      ['monthlyVolume fora do enum', { monthlyVolume: '1000' }],
      ['privacyAck false', { privacyAck: false }],
      ['privacyAck ausente', { privacyAck: undefined }],
      ['formToken ausente', { formToken: undefined }],
    ];
    for (const [label, overrides] of cases) {
      const response = await w.post(validBody(w, overrides));
      assert.equal(response.statusCode, 400, label);
      const body = response.json<{ error: { code: string; details: { path: string }[] } }>();
      assert.equal(body.error.code, 'VALIDATION_ERROR', label);
      assert.ok(body.error.details.length >= 1, label);
      assertNoSentinel(response.body, `corpo 400 (${label})`);
      assert.ok(!response.body.includes('Bcc'), label);
    }
    await w.service.drain();
    assert.equal(w.mailer.sent.length, 0);
    assert.match(
      await w.metricsText(),
      new RegExp(`sales_contact_requests_total\\{result="invalid"\\} ${String(cases.length)}`),
    );
    await finish(w);
  });

  it('limites exatos aceitos: nome 2 e 100, empresa 2 e 120, mensagem 10 e 2.000 com 40 linhas, telefone 8 e 15 dígitos', async () => {
    const w = world();
    for (const overrides of [
      { name: 'Ab', companyName: 'Cd', message: '0123456789', phone: '12345678' },
      {
        name: 'N'.repeat(100),
        companyName: 'E'.repeat(120),
        message: Array.from({ length: 40 }, () => 'x'.repeat(40)).join('\n'),
        phone: '+55 (11) 98888-77776',
      },
      { phone: '' },
      { phone: undefined, website: undefined },
    ]) {
      const response = await w.post(validBody(w, overrides));
      assert.equal(response.statusCode, 202, JSON.stringify(overrides).slice(0, 80));
    }
    await w.service.drain();
    assert.equal(w.mailer.sent.length, 4);
    await finish(w);
  });

  it('JSON malformado e corpo grande demais: recusados sem eco no log', async () => {
    const w = world();
    const malformed = await w.app.inject({
      method: 'POST',
      url: '/contact/sales',
      payload: `{"name":"${S.name}", "email": ${S.email}`,
      headers: { ...HEADERS, 'content-type': 'application/json' },
    });
    assert.equal(malformed.statusCode, 400);
    const big = await w.post(validBody(w, { message: S.message + 'x'.repeat(17_000) }));
    assert.equal(big.statusCode, 413);
    await w.service.drain();
    assert.equal(w.mailer.sent.length, 0);
    await finish(w);
  });

  it('token alterado ou com mais de 2 h = 400 FORM_EXPIRED; com menos de 3 s = 202 e nada enviado', async () => {
    const w = world();
    const good = w.token();
    const [issued, mac] = good.split('.') as [string, string];
    const altered = `${issued}.${(mac[0] === 'A' ? 'B' : 'A') + mac.slice(1)}`;
    for (const formToken of [altered, w.token(2 * 3_600_000 + 1), 'lixo']) {
      const response = await w.post(validBody(w, { formToken }));
      assert.equal(response.statusCode, 400);
      assert.equal(response.json<{ error: { code: string } }>().error.code, 'FORM_EXPIRED');
      assertNoSentinel(response.body, 'corpo FORM_EXPIRED', [formToken]);
    }
    const fast = await w.post(validBody(w, { formToken: w.token(1_000) }));
    assert.equal(fast.statusCode, 202);
    assert.deepEqual(fast.json(), { message: SALES_CONTACT_ACCEPTED });
    await w.service.drain();
    assert.equal(w.mailer.sent.length, 0);
    const metrics = await w.metricsText();
    assert.match(metrics, /sales_contact_requests_total\{result="expired"\} 3/);
    assert.match(metrics, /sales_contact_requests_total\{result="too_fast"\} 1/);
    await finish(w, [altered]);
  });

  it('honeypot preenchido: 202 idêntico (corpo e cabeçalhos) e nada enviado', async () => {
    const w = world();
    const normal = await w.post(validBody(w));
    const spam = await w.post(validBody(w, { website: S.website }));
    assert.equal(spam.statusCode, 202);
    assert.equal(spam.body, normal.body);
    const comparable = (response: LightMyRequestResponse) =>
      Object.fromEntries(
        Object.entries(response.headers).filter(([name]) => name !== 'x-request-id'),
      );
    assert.deepEqual(comparable(spam), comparable(normal));
    await w.service.drain();
    assert.equal(w.mailer.sent.length, 1, 'só o pedido normal');
    assert.match(await w.metricsText(), /sales_contact_requests_total\{result="spam"\} 1/);
    await finish(w);
  });

  it('teto diário: o 31º pedido válido do dia é 202 e não envia; no dia seguinte volta a enviar', async () => {
    const w = world();
    for (let i = 0; i < 31; i += 1) {
      const response = await w.post(validBody(w));
      assert.equal(response.statusCode, 202);
      await w.service.drain();
    }
    assert.equal(w.mailer.sent.length, 30);
    assert.match(await w.metricsText(), /sales_contact_requests_total\{result="capped"\} 1/);
    w.setNow(T0 + 24 * 3_600_000);
    assert.equal((await w.post(validBody(w))).statusCode, 202);
    await w.service.drain();
    assert.equal(w.mailer.sent.length, 31);
    await finish(w);
  });

  it('teto indisponível (Redis fora) = 503 e nada enviado', async () => {
    const w = world();
    w.cap.down = true;
    const response = await w.post(validBody(w));
    assert.equal(response.statusCode, 503);
    assertNoSentinel(response.body, 'corpo 503');
    await w.service.drain();
    assert.equal(w.mailer.sent.length, 0);
    await finish(w);
  });

  it('falha do SMTP: continua 202, result="failed", log sem dado do formulário, drain() no fechamento', async () => {
    const w = world();
    w.mailer.fail = true;
    const response = await w.post(validBody(w));
    assert.equal(response.statusCode, 202);
    await w.app.close(); // o onClose espera o envio em segundo plano
    assert.ok(w.logs.lines().some((line) => line.result === 'failed'));
    assertNoSentinel(w.logs.raw(), 'log');
  });

  it('nenhuma rota nova lê o cookie: a resposta é a mesma logado ou não', async () => {
    const w = world();
    const anonymous = await w.post(validBody(w));
    const withCookie = await w.post(validBody(w), { ...HEADERS, cookie: 'soprei_session=abc' });
    assert.equal(withCookie.statusCode, anonymous.statusCode);
    assert.equal(withCookie.body, anonymous.body);
    await finish(w);
  });
});
