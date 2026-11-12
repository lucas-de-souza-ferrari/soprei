import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type BillingNoticeKind,
  dueNotices,
  NOTICE_RECENT_END_MS,
  type NoticeSubject,
  statusToSync,
} from './billing-notices.js';
import type { SubscriptionRecord, SubscriptionStatus } from './billing.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const GRACE = 5;
const SETTINGS = { graceDays: GRACE, trialTokens: 300_000 } as const;
const END = new Date('2026-12-01T00:00:00Z');
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

function subject(
  status: SubscriptionStatus,
  overrides: {
    sub?: Partial<SubscriptionRecord>;
    usage?: Partial<NoticeSubject['usage']>;
    companies?: number;
    pendingPlanMaxCompanies?: number | null;
  } = {},
): NoticeSubject {
  return {
    subscription: {
      id: 's',
      accountId: 'a',
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
      status,
      currentPeriodStart: new Date('2026-11-01T00:00:00Z'),
      currentPeriodEnd: END,
      trialEndsAt: status === 'TRIAL' ? END : null,
      cancelAtPeriodEnd: false,
      pendingChange: null,
      ...overrides.sub,
    },
    usage: { tokens: 0, sentMessages: 0, extraReplies: 0, ...overrides.usage },
    usageWindowStart: new Date('2026-11-01T00:00:00Z'),
    companies: overrides.companies ?? 1,
    pendingPlanMaxCompanies: overrides.pendingPlanMaxCompanies ?? null,
  };
}

const kinds = (s: NoticeSubject, now: Date): BillingNoticeKind[] =>
  dueNotices(s, now, SETTINGS).map((notice) => notice.kind);

describe('dueNotices: vencimento (spec 031, E5)', () => {
  it('longe do vencimento não há aviso; a até 7 dias sai o primeiro; a até 1 dia, o segundo', () => {
    assert.deepEqual(kinds(subject('ACTIVE'), at(-8 * DAY)), []);
    assert.deepEqual(kinds(subject('ACTIVE'), at(-7 * DAY)), ['PERIOD_ENDING_7D']);
    assert.deepEqual(kinds(subject('ACTIVE'), at(-2 * DAY)), ['PERIOD_ENDING_7D']);
    assert.deepEqual(kinds(subject('ACTIVE'), at(-DAY)), ['PERIOD_ENDING_1D']);
    assert.deepEqual(kinds(subject('ACTIVE'), at(-HOUR)), ['PERIOD_ENDING_1D']);
  });

  it('a janela do aviso é o fim do período (a chave única impede repetir no mesmo ciclo)', () => {
    const [notice] = dueNotices(subject('ACTIVE'), at(-3 * DAY), SETTINGS);
    assert.equal(notice?.windowStart.getTime(), END.getTime());
  });

  it('ao vencer começa a carência (vencido) e, passada a carência, sai o aviso de carência encerrada', () => {
    assert.deepEqual(kinds(subject('ACTIVE'), at(0)), ['PERIOD_ENDED']);
    assert.deepEqual(kinds(subject('PAST_DUE'), at(4 * DAY)), ['PERIOD_ENDED']);
    // Limite exato: no instante do fim da carência já está bloqueado.
    assert.deepEqual(kinds(subject('PAST_DUE'), at(GRACE * DAY)), ['PERIOD_GRACE_ENDED']);
    assert.deepEqual(kinds(subject('ACTIVE'), at(GRACE * DAY + DAY)), ['PERIOD_GRACE_ENDED']);
  });

  it('aviso de "acabou" não sai para algo que acabou há muito tempo', () => {
    const late = GRACE * DAY + NOTICE_RECENT_END_MS;
    assert.deepEqual(kinds(subject('ACTIVE'), at(late)), []);
    assert.deepEqual(kinds(subject('ACTIVE'), at(late - 1)), ['PERIOD_GRACE_ENDED']);
  });

  it('EXPIRED gravado não recebe aviso de renovação nem de carência', () => {
    assert.deepEqual(kinds(subject('EXPIRED'), at(DAY)), []);
  });

  it('cancelada para o fim do período: nenhum aviso de renovação, vencimento ou carência', () => {
    const cancelled = { sub: { cancelAtPeriodEnd: true } };
    for (const offset of [-5 * DAY, -HOUR, 0, 2 * DAY, 6 * DAY]) {
      assert.deepEqual(kinds(subject('ACTIVE', cancelled), at(offset)), [], `offset ${offset}`);
    }
  });
});

describe('dueNotices: teste gratuito', () => {
  it('avisa a 1 dia do fim e, depois do fim (recente), que o teste terminou', () => {
    assert.deepEqual(kinds(subject('TRIAL'), at(-2 * DAY)), []);
    assert.deepEqual(kinds(subject('TRIAL'), at(-DAY)), ['TRIAL_ENDING']);
    assert.deepEqual(kinds(subject('TRIAL'), at(0)), ['TRIAL_ENDED']);
    assert.deepEqual(kinds(subject('TRIAL'), at(NOTICE_RECENT_END_MS)), []);
  });

  it('o teste não recebe aviso de renovação', () => {
    const list = kinds(subject('TRIAL'), at(-3 * HOUR));
    assert.deepEqual(list, ['TRIAL_ENDING']);
  });
});

describe('dueNotices: cotas (respostas e tokens separados)', () => {
  const now = at(-20 * DAY);

  it('80% e 100% de respostas, e de tokens, são tipos diferentes', () => {
    assert.deepEqual(kinds(subject('ACTIVE', { usage: { sentMessages: 639 } }), now), []);
    assert.deepEqual(kinds(subject('ACTIVE', { usage: { sentMessages: 640 } }), now), [
      'QUOTA_REPLIES_80',
    ]);
    assert.deepEqual(kinds(subject('ACTIVE', { usage: { tokens: 2_400_000 } }), now), [
      'QUOTA_TOKENS_80',
    ]);
    assert.deepEqual(
      kinds(subject('ACTIVE', { usage: { sentMessages: 640, tokens: 3_000_000 } }), now),
      ['QUOTA_REPLIES_80', 'QUOTA_TOKENS_100'],
    );
  });

  it('em 100% sai só o aviso de 100%, que cobre o de 80% (um e-mail só)', () => {
    const [notice] = dueNotices(subject('ACTIVE', { usage: { sentMessages: 800 } }), now, SETTINGS);
    assert.equal(notice?.kind, 'QUOTA_REPLIES_100');
    assert.deepEqual(
      notice.covers.map((cover) => cover.kind),
      ['QUOTA_REPLIES_80'],
    );
  });

  it('a janela do aviso de cota é a janela de uso (o aviso volta no mês seguinte)', () => {
    const [notice] = dueNotices(subject('ACTIVE', { usage: { sentMessages: 700 } }), now, SETTINGS);
    assert.equal(notice?.windowStart.toISOString(), '2026-11-01T00:00:00.000Z');
  });

  it('a cota efetiva soma as respostas extras compradas', () => {
    assert.deepEqual(
      kinds(subject('ACTIVE', { usage: { sentMessages: 800, extraReplies: 500 } }), now),
      [],
    );
  });

  it('o teste usa a cota de tokens própria', () => {
    assert.deepEqual(kinds(subject('TRIAL', { usage: { tokens: 240_000 } }), at(-5 * DAY)), [
      'QUOTA_TOKENS_80',
    ]);
  });

  it('na carência ainda há alerta; bloqueado (EXPIRED por tempo) não há', () => {
    const usage = { usage: { sentMessages: 800 } };
    assert.ok(kinds(subject('ACTIVE', usage), at(DAY)).includes('QUOTA_REPLIES_100'));
    assert.ok(
      !kinds(subject('ACTIVE', usage), at(GRACE * DAY + DAY)).includes('QUOTA_REPLIES_100'),
    );
  });
});

describe('dueNotices: troca agendada que não cabe', () => {
  it('avisa uma vez por período, a até 7 dias do vencimento, só se as empresas passam das vagas', () => {
    const pending = {
      sub: {
        pendingChange: { planCode: 'ESSENTIAL', cycle: 'MONTHLY', agenda: false, stock: false },
      } as const,
      companies: 3,
      pendingPlanMaxCompanies: 1,
    };
    assert.ok(!kinds(subject('ACTIVE', pending), at(-10 * DAY)).includes('DOWNGRADE_BLOCKED'));
    assert.ok(kinds(subject('ACTIVE', pending), at(-6 * DAY)).includes('DOWNGRADE_BLOCKED'));
    assert.ok(
      !kinds(subject('ACTIVE', { ...pending, companies: 1 }), at(-6 * DAY)).includes(
        'DOWNGRADE_BLOCKED',
      ),
    );
  });
});

describe('statusToSync', () => {
  it('a carência vira vencimento por tempo; o que já está certo não muda', () => {
    assert.equal(statusToSync(subject('ACTIVE').subscription, at(-DAY), GRACE), null);
    assert.equal(statusToSync(subject('ACTIVE').subscription, at(DAY), GRACE), 'PAST_DUE');
    assert.equal(statusToSync(subject('PAST_DUE').subscription, at(DAY), GRACE), null);
    assert.equal(statusToSync(subject('PAST_DUE').subscription, at(GRACE * DAY), GRACE), 'EXPIRED');
    assert.equal(statusToSync(subject('TRIAL').subscription, at(0), GRACE), 'EXPIRED');
    assert.equal(statusToSync(subject('EXPIRED').subscription, at(DAY), GRACE), null);
  });

  it('cancelada para o fim do período expira sem passar pela carência', () => {
    const cancelled = subject('ACTIVE', { sub: { cancelAtPeriodEnd: true } }).subscription;
    assert.equal(statusToSync(cancelled, at(DAY), GRACE), 'EXPIRED');
  });
});
