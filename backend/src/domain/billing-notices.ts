import {
  type QuotaSettings,
  quotaLimits,
  reachedAlertFractions,
  resolveAccess,
  type SubscriptionRecord,
  type UsageNumbers,
} from './billing.js';

/**
 * Avisos por e-mail ao titular da assinatura (spec 031, E5): regras PURAS (sem banco, sem relógio global).
 * O tipo fica em `payment_notices.kind`; a chave única (assinatura, tipo, janela) é o que faz cada aviso
 * sair UMA vez por ciclo. Nada aqui guarda e-mail, valor em dinheiro nem texto.
 */
export const BILLING_NOTICE_KINDS = [
  'QUOTA_REPLIES_80',
  'QUOTA_REPLIES_100',
  'QUOTA_TOKENS_80',
  'QUOTA_TOKENS_100',
  'PERIOD_ENDING_7D',
  'PERIOD_ENDING_1D',
  'PERIOD_ENDED',
  'PERIOD_GRACE_ENDED',
  'PAYMENT_RECEIVED',
  'PLAN_CHANGE_APPLIED',
  'DOWNGRADE_BLOCKED',
  'TRIAL_ENDING',
  'TRIAL_ENDED',
] as const;
export type BillingNoticeKind = (typeof BILLING_NOTICE_KINDS)[number];

const DAY_MS = 86_400_000;
/** Aviso de vencimento: dentro de 7 dias (e, mais perto, de 1 dia). */
export const NOTICE_ENDING_WINDOWS_DAYS = { first: 7, last: 1 } as const;
/** O teste gratuito avisa quando faltar 1 dia. */
export const NOTICE_TRIAL_ENDING_MS = DAY_MS;
/**
 * Avisos de "acabou" (teste, carência) só saem se o fim foi recente: ao ligar a cobrança ou depois de uma
 * pausa do timer, ninguém recebe um e-mail sobre algo que acabou há semanas.
 */
export const NOTICE_RECENT_END_MS = 3 * DAY_MS;

/** Um aviso devido e os tipos que ele cobre (marcados sem enviar: 100% cobre o de 80%). */
export interface DueNotice {
  readonly kind: BillingNoticeKind;
  /** Chave da janela do aviso: fim do período, fim do teste ou início da janela de uso. */
  readonly windowStart: Date;
  readonly covers: readonly { readonly kind: BillingNoticeKind; readonly windowStart: Date }[];
}

export interface NoticeSubject {
  readonly subscription: SubscriptionRecord;
  /** Uso da janela de uso corrente. */
  readonly usage: UsageNumbers;
  readonly usageWindowStart: Date;
  /** Quantas empresas a assinatura tem (só para o aviso de troca agendada que não cabe). */
  readonly companies: number;
  /** Vagas do plano da troca agendada, ou `null` se não há troca agendada. */
  readonly pendingPlanMaxCompanies: number | null;
}

/**
 * Avisos devidos a esta assinatura em `now`. Relógio e carência injetados. Regras:
 * - Só quem o acesso ainda permite recebe alerta de cota (80% e 100%, respostas e tokens separados);
 *   se a cota já está em 100%, o de 80% é coberto (um e-mail só).
 * - Cancelada para o fim do período (`cancelAtPeriodEnd`): nenhum aviso de renovação, vencimento ou carência.
 * - Teste: aviso a 1 dia do fim e, passado o fim (recente), o de teste encerrado.
 * - Pago: a até 7 dias do vencimento (e depois a até 1 dia), ao vencer (começa a carência) e ao fim da carência.
 * - Troca agendada que não cabe nas empresas atuais: um aviso por período, a até 7 dias do vencimento.
 */
export function dueNotices(
  subject: NoticeSubject,
  now: Date,
  settings: QuotaSettings,
): readonly DueNotice[] {
  const { subscription } = subject;
  const t = now.getTime();
  const periodEnd = subscription.currentPeriodEnd;
  const resolved = resolveAccess(subscription, now, settings.graceDays);
  const out: DueNotice[] = [];
  const add = (kind: BillingNoticeKind, windowStart: Date, covers: DueNotice['covers'] = []) => {
    out.push({ kind, windowStart, covers });
  };

  if (subscription.status === 'TRIAL') {
    const end = subscription.trialEndsAt ?? periodEnd;
    if (t < end.getTime() && end.getTime() - t <= NOTICE_TRIAL_ENDING_MS) {
      add('TRIAL_ENDING', end);
    } else if (t >= end.getTime() && t < end.getTime() + NOTICE_RECENT_END_MS) {
      add('TRIAL_ENDED', end);
    }
  } else if (!subscription.cancelAtPeriodEnd && subscription.status !== 'EXPIRED') {
    const remaining = periodEnd.getTime() - t;
    if (resolved.state === 'ACTIVE') {
      if (remaining <= NOTICE_ENDING_WINDOWS_DAYS.last * DAY_MS) {
        add('PERIOD_ENDING_1D', periodEnd);
      } else if (remaining <= NOTICE_ENDING_WINDOWS_DAYS.first * DAY_MS) {
        add('PERIOD_ENDING_7D', periodEnd);
      }
      if (
        remaining <= NOTICE_ENDING_WINDOWS_DAYS.first * DAY_MS &&
        subject.pendingPlanMaxCompanies !== null &&
        subject.companies > subject.pendingPlanMaxCompanies
      ) {
        add('DOWNGRADE_BLOCKED', periodEnd);
      }
    } else if (resolved.state === 'PAST_DUE') {
      add('PERIOD_ENDED', periodEnd);
    } else if (resolved.state === 'EXPIRED') {
      const graceEnd = periodEnd.getTime() + Math.max(0, settings.graceDays) * DAY_MS;
      if (t < graceEnd + NOTICE_RECENT_END_MS) add('PERIOD_GRACE_ENDED', periodEnd);
    }
  }

  // Cotas: só enquanto o acesso não está bloqueado (a IA já parou por falta de assinatura, não de cota).
  if (resolved.access !== 'blocked') {
    const limits = quotaLimits(subscription, subject.usage.extraReplies, settings);
    const quotas = [
      {
        used: subject.usage.sentMessages,
        limit: limits.replies,
        kinds: ['REPLIES_80', 'REPLIES_100'],
      },
      { used: subject.usage.tokens, limit: limits.tokens, kinds: ['TOKENS_80', 'TOKENS_100'] },
    ] as const;
    for (const quota of quotas) {
      const reached = reachedAlertFractions(quota.used, quota.limit);
      const k80 = `QUOTA_${quota.kinds[0]}` as BillingNoticeKind;
      const k100 = `QUOTA_${quota.kinds[1]}` as BillingNoticeKind;
      if (reached.includes(1)) {
        add(k100, subject.usageWindowStart, [{ kind: k80, windowStart: subject.usageWindowStart }]);
      } else if (reached.includes(0.8)) {
        add(k80, subject.usageWindowStart);
      }
    }
  }
  return out;
}

/**
 * Estado a gravar para refletir o tempo (a carência vira vencimento sozinha, sem apagar nada), ou `null` se
 * o gravado já está certo. O efetivo continua derivado do tempo pelo leitor: isto só mantém a linha em dia.
 */
export function statusToSync(
  subscription: SubscriptionRecord,
  now: Date,
  graceDays: number,
): 'PAST_DUE' | 'EXPIRED' | null {
  const { state } = resolveAccess(subscription, now, graceDays);
  if (state === 'EXPIRED' && subscription.status !== 'EXPIRED') return 'EXPIRED';
  if (state === 'PAST_DUE' && subscription.status === 'ACTIVE') return 'PAST_DUE';
  return null;
}
