import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  BillingNoticeKind,
  BillingNoticeRepository,
  NoticeCandidate,
  NoticeRecipient,
  NoticeTarget,
  PendingReceipt,
  SubscriptionRecord,
} from '../../domain/index.js';
import type { BillingNoticeResult } from '../../infrastructure/metrics/index.js';
import { captureLogs, logContains } from '../../test-support/log-capture.js';
import type { BillingMailer, BillingNoticeMail } from '../ports/billing-mailer.js';
import { BillingNoticeService } from './billing-notice.service.js';

const DAY = 86_400_000;
const GRACE = 5;
const END = new Date('2026-12-01T00:00:00Z');
const EMAIL = 'sentinela-email-titular@exemplo.test';
const SETTINGS = {
  graceDays: GRACE,
  trialTokens: 300_000,
  trialReplies: 100,
  appOrigin: 'https://site.exemplo.test',
};
const at = (offsetMs: number): Date => new Date(END.getTime() + offsetMs);

const PLAN = {
  id: 'p',
  code: 'ESSENTIAL',
  name: 'Essencial',
  maxCompanies: 3,
  monthlyTokens: 3_000_000,
  monthlyReplies: 800,
  metaEstimateMilliCents: 3_500,
  version: 1,
} as const;

function subscription(id: string, overrides: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    id,
    accountId: `a-${id}`,
    plan: PLAN,
    price: {
      id: 'pr',
      cycle: 'MONTHLY',
      baseCents: 5_900,
      agendaCents: 2_900,
      stockCents: 1_900,
      whatsappBillingMode: 'CUSTOMER_PAYS_META',
      metaPerReplyMilliCents: 3_500,
      extraPackCents: 5_900,
      extraPackReplies: 500,
      version: 1,
      validFrom: new Date('2026-01-01T00:00:00Z'),
    },
    cycle: 'MONTHLY',
    agendaEnabled: true,
    stockEnabled: false,
    status: 'ACTIVE',
    currentPeriodStart: new Date('2026-11-01T00:00:00Z'),
    currentPeriodEnd: END,
    trialEndsAt: null,
    cancelAtPeriodEnd: false,
    pendingChange: null,
    ...overrides,
  };
}

/** Repositório em memória: o `claim` é atômico como a chave única do banco. */
class MemoryNotices implements BillingNoticeRepository {
  readonly claimed = new Set<string>();
  readonly synced: string[] = [];
  candidates: NoticeCandidate[] = [];
  target: NoticeTarget | null = null;
  claimDelay: Promise<void> = Promise.resolve();

  listBatch(_now: Date, after: string | null, limit: number): Promise<readonly NoticeCandidate[]> {
    const rows = this.candidates
      .filter((row) => after === null || row.subscription.id > after)
      .sort((a, b) => a.subscription.id.localeCompare(b.subscription.id))
      .slice(0, limit);
    return Promise.resolve(rows);
  }
  receipts: PendingReceipt[] = [];
  listPendingReceipts(): Promise<readonly PendingReceipt[]> {
    return Promise.resolve(this.receipts.filter((r) => !this.claimedReceipt(r)));
  }
  private claimedReceipt(r: PendingReceipt): boolean {
    return this.claimed.has(r.subscriptionId + '|PAYMENT_RECEIVED|' + r.paidAt.toISOString());
  }
  findTarget(id?: string): Promise<NoticeTarget | null> {
    if (this.target !== null) return Promise.resolve(this.target);
    const row = this.candidates.find((c) => c.subscription.id === id);
    return Promise.resolve(
      row === undefined ? null : { subscription: row.subscription, recipient: row.recipient },
    );
  }
  async claim(subscriptionId: string, kind: BillingNoticeKind, windowStart: Date) {
    await this.claimDelay;
    const key = `${subscriptionId}|${kind}|${windowStart.toISOString()}`;
    if (this.claimed.has(key)) return false;
    this.claimed.add(key);
    return true;
  }
  release(subscriptionId: string, kind: BillingNoticeKind, windowStart: Date): Promise<void> {
    this.claimed.delete(`${subscriptionId}|${kind}|${windowStart.toISOString()}`);
    return Promise.resolve();
  }
  syncStatus(sub: Pick<SubscriptionRecord, 'id'>): Promise<boolean> {
    this.synced.push(sub.id);
    return Promise.resolve(true);
  }
}

class RecordingMailer implements BillingMailer {
  readonly sent: { email: string; mail: BillingNoticeMail }[] = [];
  failWith: Error | null = null;
  sendBillingNotice(email: string, mail: BillingNoticeMail): Promise<void> {
    if (this.failWith !== null) return Promise.reject(this.failWith);
    this.sent.push({ email, mail });
    return Promise.resolve();
  }
}

function candidate(
  id: string,
  options: {
    sub?: Partial<SubscriptionRecord>;
    usage?: Partial<NoticeCandidate['usage']>;
    recipient?: NoticeRecipient | null;
  } = {},
): NoticeCandidate {
  return {
    subscription: subscription(id, options.sub),
    usage: { tokens: 0, sentMessages: 0, extraReplies: 0, ...options.usage },
    usageWindowStart: new Date('2026-11-01T00:00:00Z'),
    companies: 1,
    pendingPlanMaxCompanies: null,
    recipient: options.recipient === undefined ? { email: EMAIL } : options.recipient,
  };
}

function build(now: Date) {
  const repository = new MemoryNotices();
  const mailer = new RecordingMailer();
  const logs = captureLogs();
  const counted: { kind: BillingNoticeKind; result: BillingNoticeResult }[] = [];
  const runs: string[] = [];
  const service = new BillingNoticeService({
    repository,
    mailer,
    logger: logs.logger,
    metrics: {
      countBillingNotice: (kind, result) => counted.push({ kind, result }),
      countBillingNoticeRun: (result) => runs.push(result),
    },
    settings: SETTINGS,
    now: () => now,
  });
  return { repository, mailer, logs, counted, runs, service };
}

describe('BillingNoticeService.runOnce (spec 031, E5)', () => {
  it('cada aviso sai uma vez: a segunda execução não reenvia', async () => {
    const t = build(at(-3 * DAY));
    t.repository.candidates = [candidate('s1')];
    const first = await t.service.runOnce();
    assert.equal(first.sent, 1);
    assert.equal(t.mailer.sent.length, 1);
    assert.equal(t.mailer.sent[0]?.email, EMAIL);
    assert.equal(t.mailer.sent[0].mail.subject, 'Sua assinatura do Soprei vence em poucos dias');
    const second = await t.service.runOnce();
    assert.equal(second.sent, 0);
    assert.equal(t.mailer.sent.length, 1);
  });

  it('duas execuções simultâneas (corrida entre timers) enviam o aviso uma só vez', async () => {
    const t = build(at(-3 * DAY));
    t.repository.candidates = Array.from({ length: 20 }, (_, index) =>
      candidate(`s${String(index).padStart(2, '0')}`),
    );
    const [a, b] = await Promise.all([t.service.runOnce(), t.service.runOnce()]);
    assert.equal(a.sent + b.sent, 20);
    assert.equal(t.mailer.sent.length, 20);
  });

  it('só a conta titular ativa e confirmada recebe: sem destinatário, nada é enviado nem marcado', async () => {
    const t = build(at(-3 * DAY));
    t.repository.candidates = [candidate('s1', { recipient: null })];
    const summary = await t.service.runOnce();
    assert.equal(summary.sent, 0);
    assert.equal(summary.skipped, 1);
    assert.equal(t.mailer.sent.length, 0);
    assert.equal(t.repository.claimed.size, 0);
    assert.deepEqual(t.counted, [{ kind: 'PERIOD_ENDING_7D', result: 'skipped_recipient' }]);
  });

  it('cancelada para o fim do período: nenhum aviso de renovação', async () => {
    const t = build(at(-3 * DAY));
    t.repository.candidates = [candidate('s1', { sub: { cancelAtPeriodEnd: true } })];
    await t.service.runOnce();
    assert.equal(t.mailer.sent.length, 0);
  });

  it('falha de SMTP: métrica e log só com id e tipo; a marca é desfeita e a próxima execução tenta de novo', async () => {
    const t = build(at(-3 * DAY));
    t.repository.candidates = [candidate('s1')];
    t.mailer.failWith = new Error(`falha para ${EMAIL} com a senha hunter2`);
    const first = await t.service.runOnce();
    assert.equal(first.failed, 1);
    assert.equal(t.repository.claimed.size, 0);
    assert.deepEqual(t.counted, [{ kind: 'PERIOD_ENDING_7D', result: 'failed' }]);
    const raw = t.logs.raw();
    assert.ok(!logContains(raw, EMAIL));
    assert.ok(!raw.includes('hunter2'));
    assert.ok(!raw.includes('vence em'));
    t.mailer.failWith = null;
    const second = await t.service.runOnce();
    assert.equal(second.sent, 1);
  });

  it('a carência vira vencimento por tempo só depois de os avisos do fim saírem', async () => {
    const t = build(at(GRACE * DAY + DAY));
    t.repository.candidates = [candidate('s1'), candidate('s2')];
    t.mailer.failWith = new Error('smtp fora');
    const failing = await t.service.runOnce();
    assert.equal(failing.synced, 0);
    t.mailer.failWith = null;
    const ok = await t.service.runOnce();
    assert.equal(ok.synced, 2);
    assert.deepEqual(t.repository.synced.slice(-2), ['s1', 's2']);
    assert.equal(
      t.mailer.sent.every((entry) => entry.mail.subject.includes('carência')),
      true,
    );
  });

  it('percorre em lotes e para no teto de lotes (o resto fica para a próxima execução)', async () => {
    const repository = new MemoryNotices();
    repository.candidates = Array.from({ length: 7 }, (_, index) => candidate(`s${String(index)}`));
    const mailer = new RecordingMailer();
    const service = new BillingNoticeService({
      repository,
      mailer,
      logger: captureLogs().logger,
      settings: SETTINGS,
      now: () => at(-3 * DAY),
      batchSize: 2,
      maxBatches: 2,
    });
    const summary = await service.runOnce();
    assert.equal(summary.scanned, 4);
    assert.equal(mailer.sent.length, 4);
  });

  it('um alerta de cota em 100% sai como um e-mail só (cobre o de 80%) e nada de e-mail ou contagem em log', async () => {
    const t = build(at(-20 * DAY));
    t.repository.candidates = [candidate('s1', { usage: { sentMessages: 800 } })];
    await t.service.runOnce();
    assert.equal(t.mailer.sent.length, 1);
    assert.equal(t.mailer.sent[0]?.mail.subject, 'As respostas do seu plano do Soprei acabaram');
    assert.ok(t.mailer.sent[0].mail.text.includes('800 de 800'));
    const raw = t.logs.raw();
    assert.ok(!logContains(raw, EMAIL));
    assert.ok(!raw.includes('800 de 800'));
    // Segunda execução: nem o de 100% nem o de 80% saem.
    await t.service.runOnce();
    assert.equal(t.mailer.sent.length, 1);
  });

  it('as métricas usam só tipo e resultado (conjuntos fixos)', async () => {
    const t = build(at(-3 * DAY));
    t.repository.candidates = [candidate('s1')];
    await t.service.runOnce();
    assert.deepEqual(t.counted, [{ kind: 'PERIOD_ENDING_7D', result: 'sent' }]);
    assert.deepEqual(t.runs, ['ok']);
  });

  it('falha ao ler o lote não lança: conta a execução como erro', async () => {
    const t = build(at(-3 * DAY));
    t.repository.listBatch = () => Promise.reject(new Error(`banco fora ${EMAIL}`));
    const summary = await t.service.runOnce();
    assert.equal(summary.scanned, 0);
    assert.deepEqual(t.runs, ['error']);
    assert.ok(!logContains(t.logs.raw(), EMAIL));
  });
});

describe('BillingNoticeService.paymentGranted (spec 031, E5)', () => {
  const granted = (applied: boolean) => ({
    subscriptionId: 's1',
    paidAt: at(-DAY),
    orderKind: 'RENEWAL' as const,
    appliedPendingChange: applied,
  });

  it('envia o recibo uma vez e, se a renovação aplicou a troca agendada, o aviso da troca', async () => {
    const t = build(at(-DAY));
    t.repository.target = { subscription: subscription('s1'), recipient: { email: EMAIL } };
    await t.service.paymentGranted(granted(true));
    await t.service.paymentGranted(granted(true));
    assert.deepEqual(
      t.mailer.sent.map((entry) => entry.mail.subject),
      ['Recebemos o seu pagamento no Soprei', 'Sua troca de plano do Soprei foi aplicada'],
    );
  });

  it('sem troca aplicada só o recibo; conta sem e-mail confirmado não recebe; nunca rejeita', async () => {
    const t = build(at(-DAY));
    t.repository.target = { subscription: subscription('s1'), recipient: { email: EMAIL } };
    await t.service.paymentGranted(granted(false));
    assert.equal(t.mailer.sent.length, 1);

    const none = build(at(-DAY));
    none.repository.target = { subscription: subscription('s1'), recipient: null };
    await none.service.paymentGranted(granted(true));
    assert.equal(none.mailer.sent.length, 0);

    const broken = build(at(-DAY));
    broken.repository.findTarget = () => Promise.reject(new Error(EMAIL));
    await broken.service.paymentGranted(granted(true));
    assert.ok(!logContains(broken.logs.raw(), EMAIL));
  });
});

describe('cursor rotativo, releitura e recibo (spec 031, E5, revisão)', () => {
  it('com mais assinaturas que o teto de lotes, a execução seguinte continua de onde parou e volta ao início ao esgotar', async () => {
    const repository = new MemoryNotices();
    repository.candidates = Array.from({ length: 7 }, (_, index) => candidate('s' + String(index)));
    const mailer = new RecordingMailer();
    const service = new BillingNoticeService({
      repository,
      mailer,
      logger: captureLogs().logger,
      settings: SETTINGS,
      now: () => at(-3 * DAY),
      batchSize: 2,
      maxBatches: 2,
    });
    const visited = async (): Promise<string[]> => {
      const before = mailer.sent.length;
      await service.runOnce();
      return mailer.sent.slice(before).map((entry) => entry.mail.subject);
    };
    assert.equal((await visited()).length, 4); // s0 a s3
    assert.equal((await visited()).length, 3); // s4 a s6 e esgotou
    // Já enviados: a terceira volta ao início e visita tudo de novo, sem reenviar (chave única).
    const third = await service.runOnce();
    assert.equal(third.scanned, 4);
    assert.equal(third.sent, 0);
    assert.equal(mailer.sent.length, 7);
  });

  it('um pagamento no meio da varredura: o aviso de vencido é descartado se o período já foi renovado', async () => {
    const t = build(at(GRACE * 0 + DAY));
    const stale = candidate('s1');
    t.repository.candidates = [stale];
    // A leitura imediatamente antes do envio já vê o período renovado.
    t.repository.target = {
      subscription: subscription('s1', { currentPeriodEnd: new Date(END.getTime() + 30 * DAY) }),
      recipient: { email: EMAIL },
    };
    const summary = await t.service.runOnce();
    assert.equal(summary.sent, 0);
    assert.equal(t.mailer.sent.length, 0);
    assert.equal(t.repository.claimed.size, 0);
  });

  it('recibo que não saiu é reenviado pela tarefa, uma vez só', async () => {
    const t = build(at(-DAY));
    t.repository.target = { subscription: subscription('s1'), recipient: { email: EMAIL } };
    t.repository.receipts = [{ subscriptionId: 's1', paidAt: at(-2 * DAY) }];
    await t.service.runOnce();
    await t.service.runOnce();
    assert.deepEqual(
      t.mailer.sent.map((entry) => entry.mail.subject),
      ['Recebemos o seu pagamento no Soprei'],
    );
  });
});
