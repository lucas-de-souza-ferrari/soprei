import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { BillingNoticeService } from '../../application/billing/billing-notice.service.js';
import { CheckoutService } from '../../application/billing/checkout.service.js';
import { PaymentVerifier } from '../../application/billing/payment-verifier.js';
import { deriveWebhookSecret } from '../../application/billing/webhook-token.js';
import type { BillingMailer, BillingNoticeMail } from '../../application/ports/billing-mailer.js';
import { InfinitepayClient } from '../external-apis/infinitepay/infinitepay.client.js';
import { createLogger } from '../logger/logger.js';
import { createMetrics } from '../metrics/index.js';
import { SecretString } from '../../shared/types/index.js';
import { FakeInfinitepayApi } from '../../test-support/fake-infinitepay-api.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { captureLogs, logContains } from '../../test-support/log-capture.js';
import { createDatabase, type Database } from './database.js';
import { PrismaBillingNoticeRepository } from './repositories/billing-notice.repository.js';
import { PrismaBillingRepository } from './repositories/billing.repository.js';
import { PrismaCheckoutRepository } from './repositories/checkout.repository.js';

// Spec 031 (E5): avisos de cobrança por e-mail contra o Postgres real (soprei_test), mailer falso e relógio
// injetado. Nenhum e-mail real, nenhuma chamada à InfinitePay real. Pool 30 e prazo 30 s por causa da corrida.
const baseConfig = loadIntegrationConfig();
const config = { ...baseConfig, DB_POOL_MAX: 30, DB_POOL_CONNECTION_TIMEOUT_MS: 30_000 };
const DAY = 86_400_000;
const GRACE = 5;
const SETTINGS = { graceDays: GRACE, trialDays: 7, trialTokens: 300_000 };
const APP_ORIGIN = 'https://site.exemplo.test';
const API_KEY = `inchk_${randomBytes(12).toString('hex')}`;
const RUN = randomBytes(4).toString('hex');
const EMAIL_SENTINEL = `sentinela-${RUN}`;

let database: Database;
let billing: PrismaBillingRepository;
let checkoutRepo: PrismaCheckoutRepository;
let notices: PrismaBillingNoticeRepository;
let fake: FakeInfinitepayApi;
let clock = new Date('2026-11-10T12:00:00Z');
const accountIds: string[] = [];
const subscriptionIds = new Set<string>();

const db = () => database.prisma;

class RecordingMailer implements BillingMailer {
  readonly sent: { email: string; mail: BillingNoticeMail }[] = [];
  fail = false;
  sendBillingNotice(email: string, mail: BillingNoticeMail): Promise<void> {
    if (this.fail) return Promise.reject(new Error(`SMTP recusou ${email}`));
    this.sent.push({ email, mail });
    return Promise.resolve();
  }
  /** Só o que foi para as contas deste arquivo (a tabela é global e outros testes deixam linhas). */
  mine(): { email: string; mail: BillingNoticeMail }[] {
    return this.sent.filter((entry) => entry.email.includes(EMAIL_SENTINEL));
  }
}

function service(mailer: RecordingMailer, logs = captureLogs(), metrics = createMetrics()) {
  return new BillingNoticeService({
    repository: notices,
    mailer,
    logger: logs.logger,
    metrics,
    settings: { graceDays: GRACE, trialTokens: SETTINGS.trialTokens, appOrigin: APP_ORIGIN },
    now: () => clock,
  });
}

async function newAccount(
  label: string,
  extra: { verified?: boolean; status?: 'ACTIVE' | 'DISABLED' } = {},
): Promise<{ id: string; email: string }> {
  const email = `${EMAIL_SENTINEL}-${label}-${randomBytes(4).toString('hex')}@exemplo.test`;
  const row = await db().account.create({
    data: {
      email,
      passwordHash: 'x',
      emailVerifiedAt: extra.verified === false ? null : new Date(),
      status: extra.status ?? 'ACTIVE',
    },
  });
  accountIds.push(row.id);
  return { id: row.id, email };
}

/** Assinatura paga (ACTIVE, plano Essencial mensal) cujo período termina em `endsInMs` a partir de `clock`. */
async function paidSubscription(
  label: string,
  endsInMs: number,
  extra: Parameters<typeof newAccount>[1] & { cancel?: boolean } = {},
) {
  const account = await newAccount(label, extra);
  const trial = await billing.ensureTrial(account.id, clock, SETTINGS);
  subscriptionIds.add(trial.id);
  const end = new Date(clock.getTime() + endsInMs);
  await db().subscription.update({
    where: { id: trial.id },
    data: {
      status: 'ACTIVE',
      trialEndsAt: null,
      currentPeriodStart: new Date(end.getTime() - 30 * DAY),
      currentPeriodEnd: end,
      cancelAtPeriodEnd: extra.cancel ?? false,
    },
  });
  return { account, subscriptionId: trial.id, end };
}

before(async () => {
  database = createDatabase(config, createLogger(config));
  billing = new PrismaBillingRepository(database.prisma);
  checkoutRepo = new PrismaCheckoutRepository(database.prisma);
  notices = new PrismaBillingNoticeRepository(database.prisma);
  fake = new FakeInfinitepayApi(API_KEY);
  await fake.start();
});

beforeEach(() => {
  clock = new Date('2026-11-10T12:00:00Z');
});

after(async () => {
  try {
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

describe('avisos periódicos com o banco real (spec 031, E5)', () => {
  it('aviso de 7 dias: sai uma vez por ciclo, mesmo em execuções repetidas e simultâneas (corrida entre timers)', async () => {
    const { account } = await paidSubscription('sete', 6 * DAY);
    const mailer = new RecordingMailer();
    const a = service(mailer);
    const b = service(mailer);
    await Promise.all([a.runOnce(), b.runOnce(), a.runOnce(), b.runOnce()]);
    await a.runOnce();
    const mine = mailer.mine().filter((entry) => entry.email === account.email);
    assert.equal(mine.length, 1, 'um e-mail só por ciclo e tipo');
    assert.equal(mine[0]?.mail.subject, 'Sua assinatura do Soprei vence em poucos dias');
    assert.ok(mine[0].mail.text.includes(`${APP_ORIGIN}/painel/assinatura`));
    const marks = await db().paymentNotice.count({
      where: { kind: 'PERIOD_ENDING_7D', subscription: { accountId: account.id } },
    });
    assert.equal(marks, 1);
  });

  it('a 1 dia sai o aviso de 24 h; depois de vencer, o de vencido; e a carência encerrada vira EXPIRED sem apagar nada', async () => {
    const { account, subscriptionId, end } = await paidSubscription('ciclo', 6 * DAY);
    const mailer = new RecordingMailer();
    const s = service(mailer);
    const subjects = (): string[] =>
      mailer
        .mine()
        .filter((entry) => entry.email === account.email)
        .map((entry) => entry.mail.subject);

    await s.runOnce();
    clock = new Date(end.getTime() - 3_600_000);
    await s.runOnce();
    clock = new Date(end.getTime() + 1_000);
    await s.runOnce();
    assert.equal(
      (await db().subscription.findFirst({ where: { id: subscriptionId } }))?.status,
      'PAST_DUE',
    );
    clock = new Date(end.getTime() + GRACE * DAY + 1_000);
    await s.runOnce();
    await s.runOnce();
    assert.deepEqual(subjects(), [
      'Sua assinatura do Soprei vence em poucos dias',
      'Sua assinatura do Soprei vence em menos de 24 horas',
      'Sua assinatura do Soprei venceu',
      'A carência da sua assinatura do Soprei terminou',
    ]);
    // O estado gravado acompanha o tempo e nada foi apagado (assinatura, conta e marcas seguem).
    const row = await db().subscription.findFirst({ where: { id: subscriptionId } });
    assert.equal(row?.status, 'EXPIRED');
    assert.equal(await db().paymentNotice.count({ where: { subscriptionId } }), 4);
  });

  it('só a conta titular ativa e com e-mail confirmado recebe; a conta sem e-mail confirmado ou desativada não', async () => {
    const unverified = await paidSubscription('naoconf', 3 * DAY, { verified: false });
    const disabled = await paidSubscription('desativada', 3 * DAY, { status: 'DISABLED' });
    const ok = await paidSubscription('ok', 3 * DAY);
    const mailer = new RecordingMailer();
    await service(mailer).runOnce();
    const to = mailer.mine().map((entry) => entry.email);
    assert.ok(to.includes(ok.account.email));
    assert.ok(!to.includes(unverified.account.email));
    assert.ok(!to.includes(disabled.account.email));
  });

  it('cancelada para o fim do período: sem avisos de renovação nem de carência', async () => {
    const { account, end } = await paidSubscription('cancelada', 3 * DAY, { cancel: true });
    const mailer = new RecordingMailer();
    const s = service(mailer);
    await s.runOnce();
    clock = new Date(end.getTime() + DAY);
    await s.runOnce();
    assert.equal(mailer.mine().filter((entry) => entry.email === account.email).length, 0);
  });

  it('o aviso de 80% e o de 100% de cada cota saem separados, uma vez por janela, com o uso real do contador', async () => {
    const { account, subscriptionId, end } = await paidSubscription('cota', 20 * DAY);
    const windowStart = new Date(end.getTime() - 30 * DAY);
    // Essencial: 800 respostas e 3.000.000 de tokens por janela.
    await db().usageCounter.create({
      data: { subscriptionId, windowStart, sentMessages: 650n, tokens: 3_000_000n },
    });
    const mailer = new RecordingMailer();
    const s = service(mailer);
    const subjects = (): string[] =>
      mailer
        .mine()
        .filter((entry) => entry.email === account.email)
        .map((entry) => entry.mail.subject)
        .sort();
    await s.runOnce();
    assert.deepEqual(subjects(), [
      'A cota de IA do seu plano do Soprei acabou',
      'Você já usou 80% das respostas do seu plano do Soprei',
    ]);
    // Em 100% de respostas: um e-mail novo; o de 80% já tinha saído e não se repete.
    await db().usageCounter.updateMany({
      where: { subscriptionId, windowStart },
      data: { sentMessages: 800n },
    });
    await s.runOnce();
    await s.runOnce();
    assert.equal(subjects().length, 3);
    assert.ok(subjects().includes('As respostas do seu plano do Soprei acabaram'));
  });

  it('uma execução que falha no SMTP desfaz a marca: a seguinte envia; log e métrica sem e-mail', async () => {
    const { account } = await paidSubscription('smtp', 4 * DAY);
    const mailer = new RecordingMailer();
    const logs = captureLogs();
    const metrics = createMetrics();
    const s = service(mailer, logs, metrics);
    mailer.fail = true;
    await s.runOnce();
    assert.equal(mailer.mine().filter((entry) => entry.email === account.email).length, 0);
    const raw = logs.raw();
    assert.ok(!logContains(raw, account.email));
    assert.ok(!logContains(raw, EMAIL_SENTINEL));
    const exposition = await metrics.registry.metrics();
    assert.ok(!exposition.includes(EMAIL_SENTINEL));
    assert.match(exposition, /billing_notices_total\{kind="PERIOD_ENDING_7D",result="failed"\}/);
    mailer.fail = false;
    await s.runOnce();
    assert.equal(mailer.mine().filter((entry) => entry.email === account.email).length, 1);
  });

  it('a troca agendada para um plano com menos vagas que as empresas avisa uma vez por período', async () => {
    const { account, subscriptionId } = await paidSubscription('bloqueio', 5 * DAY);
    // Plano Profissional (3 empresas) com troca agendada para o Essencial (1 empresa) e 2 empresas: não cabe.
    const professional = await db().plan.findFirst({
      where: { code: 'PROFESSIONAL', active: true },
    });
    const price = await db().planPrice.findFirst({ where: { planId: professional?.id ?? '' } });
    assert.ok(professional !== null && price !== null);
    await db().subscription.update({
      where: { id: subscriptionId },
      data: {
        planId: professional.id,
        priceId: price.id,
        pendingChange: { planCode: 'ESSENTIAL', cycle: 'MONTHLY', agenda: false, stock: false },
      },
    });
    const owners = await Promise.all(
      [1, 2].map((n) =>
        db().company.create({
          data: { slug: `bloq-${RUN}-${String(n)}`, name: `Bloqueio ${String(n)}`, subscriptionId },
        }),
      ),
    );
    try {
      const mailer = new RecordingMailer();
      const s = service(mailer);
      await s.runOnce();
      await s.runOnce();
      const subjects = mailer
        .mine()
        .filter((entry) => entry.email === account.email)
        .map((entry) => entry.mail.subject);
      assert.ok(subjects.includes('Sua troca de plano agendada não poderá ser aplicada'));
      assert.equal(
        subjects.filter((subject) => subject.startsWith('Sua troca de plano agendada')).length,
        1,
      );
    } finally {
      await db().company.deleteMany({ where: { id: { in: owners.map((row) => row.id) } } });
    }
  });

  it('a gravação do estado é condicional: um período renovado no meio não é desfeito', async () => {
    const { subscriptionId, end } = await paidSubscription('cond', -DAY);
    const sub = await billing.findSubscription(
      (await db().subscription.findFirst({ where: { id: subscriptionId } }))?.accountId ?? '',
    );
    assert.ok(sub !== null);
    // Simula a renovação entre a leitura e a gravação.
    await db().subscription.update({
      where: { id: subscriptionId },
      data: { currentPeriodEnd: new Date(end.getTime() + 30 * DAY) },
    });
    assert.equal(await notices.syncStatus(sub, 'PAST_DUE'), false);
    assert.equal(
      (await db().subscription.findFirst({ where: { id: subscriptionId } }))?.status,
      'ACTIVE',
    );
  });
});

describe('aviso de pagamento recebido e de troca aplicada (spec 031, E5)', () => {
  function checkoutStack(mailer: RecordingMailer) {
    const logs = captureLogs();
    const metrics = createMetrics();
    const provider = new InfinitepayClient({
      baseUrl: fake.baseUrl,
      apiKey: new SecretString(API_KEY),
      handle: 'loja-teste',
      timeoutMs: 2_000,
      checkoutHost: '127.0.0.1',
    });
    const noticeService = service(mailer, logs, metrics);
    const verifier = new PaymentVerifier({
      checkout: checkoutRepo,
      provider,
      graceDays: GRACE,
      logger: logs.logger,
      metrics,
      notifier: noticeService,
      cooldownMs: 0,
      now: () => clock,
      sleep: () => Promise.resolve(),
    });
    const checkout = new CheckoutService({
      billing,
      checkout: checkoutRepo,
      provider,
      verifier,
      settings: {
        graceDays: GRACE,
        appOrigin: APP_ORIGIN,
        webhookBaseUrl: 'https://api.exemplo.test',
        allowSopreiPaysMeta: false,
        webhookSecret: deriveWebhookSecret('segredo-de-teste-do-webhook-0123456789'),
        sendCustomerEmail: false,
      },
      logger: logs.logger,
      metrics,
      now: () => clock,
    });
    return { checkout, verifier, logs, metrics };
  }

  it('pagamento concedido envia o recibo uma vez (mesmo confirmado várias vezes); a renovação que aplica a troca agendada envia também o aviso da troca', async () => {
    const mailer = new RecordingMailer();
    const s = checkoutStack(mailer);
    const account = await newAccount('pagou');
    const trial = await billing.ensureTrial(account.id, clock, SETTINGS);
    subscriptionIds.add(trial.id);
    const subjectsOf = () =>
      mailer
        .mine()
        .filter((entry) => entry.email === account.email)
        .map((entry) => entry.mail.subject);

    const first = await s.checkout.createOrder(account, {
      planCode: 'ESSENTIAL',
      cycle: 'MONTHLY',
      agenda: true,
      stock: false,
    });
    fake.markPaid(first.orderId, { amount: first.amountCents });
    await Promise.all([
      s.verifier.verify(first.orderId),
      s.verifier.verify(first.orderId),
      s.verifier.verify(first.orderId),
    ]);
    await s.verifier.drain();
    assert.deepEqual(subjectsOf(), ['Recebemos o seu pagamento no Soprei']);

    // Troca agendada (retirar a Agenda) e renovação que a aplica.
    await s.checkout.scheduleChange(account.id, {
      planCode: 'ESSENTIAL',
      cycle: 'MONTHLY',
      agenda: false,
      stock: false,
    });
    clock = new Date(clock.getTime() + 20 * DAY);
    const renewal = await s.checkout.createOrder(account, {
      planCode: 'ESSENTIAL',
      cycle: 'MONTHLY',
      agenda: false,
      stock: false,
    });
    fake.markPaid(renewal.orderId, { amount: renewal.amountCents });
    await s.verifier.verify(renewal.orderId);
    await s.verifier.drain();
    assert.deepEqual(subjectsOf(), [
      'Recebemos o seu pagamento no Soprei',
      'Recebemos o seu pagamento no Soprei',
      'Sua troca de plano do Soprei foi aplicada',
    ]);
    const text = mailer.mine().at(-1)?.mail.text ?? '';
    assert.ok(!/R\$/.test(text));
    // Nada de e-mail nem texto de aviso em log ou métrica.
    assert.ok(!logContains(s.logs.raw(), account.email));
    assert.ok(!(await s.metrics.registry.metrics()).includes(EMAIL_SENTINEL));
  });
});
