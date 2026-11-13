import type { FastifyBaseLogger } from 'fastify';
import {
  type BillingNoticeKind,
  type BillingNoticeRepository,
  type CatalogLike,
  dueNotices,
  type DueNotice,
  type NoticeRecipient,
  type PaymentOrderKindValue,
  type QuotaSettings,
  quotaLimits,
  renewalPriceChange,
  renewalPriceIncrease,
  statusToSync,
  type SubscriptionRecord,
  type UsageNumbers,
  usageWindowEnd,
} from '../../domain/index.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import type { BillingMailer } from '../ports/billing-mailer.js';
import { type AiResume, billingNoticeMail, type BillingMailData } from './billing-mail.js';

const DAY_MS = 86_400_000;
/** Assinaturas lidas por lote e lotes por execução (o resto fica para a próxima; nada é perdido). */
export const NOTICE_BATCH_SIZE = 100;
export const NOTICE_MAX_BATCHES = 20;
/** Recibos não enviados: tenta de novo os pagamentos dos últimos 2 dias (até 50 por execução). */
const RECEIPT_RETRY_WINDOW_MS = 2 * DAY_MS;
const RECEIPT_RETRY_LIMIT = 50;

export interface BillingNoticeServiceDeps {
  readonly repository: BillingNoticeRepository;
  readonly mailer: BillingMailer;
  readonly logger: FastifyBaseLogger;
  readonly metrics?: Pick<Metrics, 'countBillingNotice' | 'countBillingNoticeRun'> | undefined;
  readonly settings: QuotaSettings & { readonly appOrigin: string };
  readonly now?: (() => Date) | undefined;
  readonly batchSize?: number | undefined;
  readonly maxBatches?: number | undefined;
}

export interface NoticeRunSummary {
  readonly scanned: number;
  readonly sent: number;
  readonly failed: number;
  readonly skipped: number;
  readonly synced: number;
}

type SendResult = 'sent' | 'failed' | 'duplicate' | 'skipped';

/**
 * Avisos de cobrança por e-mail ao titular (spec 031, E5). Dois caminhos: a tarefa periódica (vencimento,
 * carência, fim do teste, cotas, troca agendada que não cabe) e o evento de pagamento concedido (pagamento
 * recebido, troca aplicada). Cada aviso sai UMA vez por ciclo e tipo: a trava é a inserção em `payment_notices`
 * (chave única), então duas execuções simultâneas nunca enviam o mesmo e-mail; se o envio falha, a marca é
 * desfeita e a próxima execução tenta de novo. Só vai e-mail à conta titular ativa e confirmada. Nunca lança.
 * O endereço, o texto e os valores nunca vão a log nem a métrica (só id da assinatura, tipo e resultado).
 */
export class BillingNoticeService {
  /**
   * Cursor rotativo entre execuções (só em memória): a próxima continua de onde a anterior parou e volta ao
   * início ao esgotar a lista, então com mais assinaturas que o teto de lotes nenhuma fica sem ser visitada.
   */
  private cursor: string | null = null;

  constructor(private readonly deps: BillingNoticeServiceDeps) {}

  async runOnce(): Promise<NoticeRunSummary> {
    const { repository, logger, metrics, settings } = this.deps;
    const now = this.deps.now?.() ?? new Date();
    const batchSize = this.deps.batchSize ?? NOTICE_BATCH_SIZE;
    const maxBatches = this.deps.maxBatches ?? NOTICE_MAX_BATCHES;
    let scanned = 0;
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    let synced = 0;
    let after = this.cursor;
    let exhausted = false;
    try {
      for (let batch = 0; batch < maxBatches; batch += 1) {
        const candidates = await repository.listBatch(now, after, batchSize);
        if (candidates.length === 0) {
          exhausted = true;
          break;
        }
        for (const candidate of candidates) {
          scanned += 1;
          let failedHere = false;
          try {
            for (const notice of dueNotices(candidate, now, settings)) {
              // Relê a assinatura imediatamente antes de enviar um aviso de período: um pagamento no meio
              // da varredura não pode gerar um e-mail velho ("venceu") logo depois.
              if (await this.isStale(candidate.subscription.id, notice, candidate.catalog)) {
                continue;
              }
              const result = await this.sendNotice(
                candidate.subscription,
                candidate.recipient,
                notice,
                this.dataFor(candidate.subscription, candidate.usage, notice.kind, {
                  usageWindowStart: candidate.usageWindowStart,
                  catalog: candidate.catalog,
                }),
              );
              if (result === 'sent') sent += 1;
              else if (result === 'failed') {
                failed += 1;
                failedHere = true;
              } else if (result === 'skipped') skipped += 1;
            }
            // A carência vira vencimento por tempo (sem apagar nada). Só depois de os avisos do fim terem
            // saído: se um envio falhou, a linha fica como está e a próxima execução tenta de novo.
            const next = statusToSync(candidate.subscription, now, settings.graceDays);
            if (
              !failedHere &&
              next !== null &&
              (await repository.syncStatus(candidate.subscription, next))
            ) {
              synced += 1;
            }
          } catch (error) {
            logger.error(
              {
                subscriptionId: candidate.subscription.id,
                errName: error instanceof Error ? error.name : typeof error,
              },
              'falha ao processar os avisos de uma assinatura',
            );
          }
        }
        after = candidates.at(-1)?.subscription.id ?? null;
        if (candidates.length < batchSize) {
          exhausted = true;
          break;
        }
      }
      sent += await this.retryReceipts(now);
      metrics?.countBillingNoticeRun('ok');
    } catch (error) {
      metrics?.countBillingNoticeRun('error');
      logger.error(
        { errName: error instanceof Error ? error.name : typeof error },
        'falha na tarefa de avisos de cobrança',
      );
    }
    this.cursor = exhausted ? null : after;
    if (sent + failed + synced > 0) {
      logger.info({ scanned, sent, failed, skipped, synced }, 'avisos de cobrança');
    }
    return { scanned, sent, failed, skipped, synced };
  }

  /**
   * O aviso de período ainda vale? Relê a assinatura: o fim do período, o teste e o cancelamento precisam ser os
   * da varredura. No reajuste, também reconfere que a renovação ainda sobe (um upgrade pago ou uma troca
   * agendada no meio da varredura tornam o aviso falso).
   */
  private async isStale(
    subscriptionId: string,
    notice: DueNotice,
    catalog?: readonly CatalogLike[],
  ): Promise<boolean> {
    const periodKinds: readonly BillingNoticeKind[] = [
      'PERIOD_ENDING_7D',
      'PERIOD_ENDING_1D',
      'PERIOD_ENDED',
      'PERIOD_GRACE_ENDED',
      'PRICE_CHANGE',
      'DOWNGRADE_BLOCKED',
      'TRIAL_ENDING',
      'TRIAL_ENDED',
    ];
    if (!periodKinds.includes(notice.kind)) return false;
    const fresh = await this.deps.repository.findTarget(subscriptionId);
    if (fresh === null) return true;
    const sub = fresh.subscription;
    const key =
      notice.kind === 'TRIAL_ENDING' || notice.kind === 'TRIAL_ENDED'
        ? (sub.trialEndsAt ?? sub.currentPeriodEnd)
        : sub.currentPeriodEnd;
    if (key.getTime() !== notice.windowStart.getTime()) return true;
    if (notice.kind.startsWith('TRIAL')) return sub.status !== 'TRIAL';
    if (sub.status === 'TRIAL' || sub.status === 'EXPIRED' || sub.cancelAtPeriodEnd) return true;
    if (notice.kind === 'PRICE_CHANGE') {
      return catalog === undefined || !renewalPriceIncrease(sub, catalog);
    }
    return false;
  }

  /** Recibos de pagamentos concedidos cujo e-mail não saiu (falha de SMTP ou queda): a tarefa os reenvia, uma vez só pela chave única. */
  private async retryReceipts(now: Date): Promise<number> {
    const pending = await this.deps.repository.listPendingReceipts(
      new Date(now.getTime() - RECEIPT_RETRY_WINDOW_MS),
      RECEIPT_RETRY_LIMIT,
    );
    let sent = 0;
    for (const receipt of pending) {
      const target = await this.deps.repository.findTarget(receipt.subscriptionId);
      if (target === null) continue;
      const result = await this.sendNotice(
        target.subscription,
        target.recipient,
        { kind: 'PAYMENT_RECEIVED', windowStart: receipt.paidAt, covers: [] },
        this.dataFor(target.subscription, undefined, 'PAYMENT_RECEIVED'),
      );
      if (result === 'sent') sent += 1;
    }
    return sent;
  }

  /** Pagamento concedido (evento): recibo e, se a renovação aplicou a troca agendada, o aviso da troca. */
  async paymentGranted(input: {
    readonly subscriptionId: string;
    readonly paidAt: Date;
    readonly orderKind: PaymentOrderKindValue;
    readonly appliedPendingChange: boolean;
  }): Promise<void> {
    try {
      const target = await this.deps.repository.findTarget(input.subscriptionId);
      if (target === null) return;
      const kinds: BillingNoticeKind[] = ['PAYMENT_RECEIVED'];
      if (input.appliedPendingChange) kinds.push('PLAN_CHANGE_APPLIED');
      for (const kind of kinds) {
        await this.sendNotice(
          target.subscription,
          target.recipient,
          { kind, windowStart: input.paidAt, covers: [] },
          this.dataFor(target.subscription, undefined, kind),
        );
      }
    } catch (error) {
      this.deps.logger.error(
        {
          subscriptionId: input.subscriptionId,
          errName: error instanceof Error ? error.name : typeof error,
        },
        'falha ao enviar o aviso de pagamento',
      );
    }
  }

  private dataFor(
    subscription: SubscriptionRecord,
    usage: UsageNumbers | undefined,
    kind: BillingNoticeKind,
    context: {
      readonly usageWindowStart?: Date | undefined;
      readonly catalog?: readonly CatalogLike[] | undefined;
    } = {},
  ): BillingMailData {
    const { settings } = this.deps;
    const aiResume =
      kind === 'QUOTA_TOKENS_100' ? aiResumeOf(subscription, context.usageWindowStart) : undefined;
    // O valor e o nome do plano da renovação vêm só do catálogo vigente (o mesmo que decidiu o aviso).
    const renewal =
      kind === 'PRICE_CHANGE' && context.catalog !== undefined
        ? renewalPriceChange(subscription, context.catalog)
        : null;
    const quota =
      usage !== undefined && (kind === 'QUOTA_REPLIES_80' || kind === 'QUOTA_REPLIES_100')
        ? {
            used: usage.sentMessages,
            limit: quotaLimits(subscription, usage.extraReplies, settings).replies,
          }
        : undefined;
    return {
      planName: renewal?.planName ?? subscription.plan.name,
      periodEnd: subscription.currentPeriodEnd,
      graceEnd: new Date(
        subscription.currentPeriodEnd.getTime() + Math.max(0, settings.graceDays) * DAY_MS,
      ),
      quota,
      aiResume,
      renewalCents: renewal?.nextCents,
    };
  }

  private async sendNotice(
    subscription: SubscriptionRecord,
    recipient: NoticeRecipient | null,
    notice: DueNotice,
    data: BillingMailData,
  ): Promise<SendResult> {
    const { repository, mailer, logger, metrics, settings } = this.deps;
    if (recipient === null) {
      // Conta desativada ou sem e-mail confirmado: nada é enviado nem marcado.
      metrics?.countBillingNotice(notice.kind, 'skipped_recipient');
      return 'skipped';
    }
    // Os tipos cobertos (100% cobre 80%) são marcados sem enviar: um e-mail só.
    for (const covered of notice.covers) {
      await repository.claim(subscription.id, covered.kind, covered.windowStart);
    }
    if (!(await repository.claim(subscription.id, notice.kind, notice.windowStart))) {
      return 'duplicate';
    }
    try {
      await mailer.sendBillingNotice(
        recipient.email,
        billingNoticeMail(notice.kind, data, settings.appOrigin),
      );
      metrics?.countBillingNotice(notice.kind, 'sent');
      return 'sent';
    } catch {
      // Falha de SMTP: só tipo e resultado (nunca e-mail, texto nem a mensagem do erro). A marca é desfeita
      // para a próxima execução tentar de novo.
      metrics?.countBillingNotice(notice.kind, 'failed');
      logger.warn(
        { subscriptionId: subscription.id, kind: notice.kind, result: 'failed' },
        'falha ao enviar aviso de cobrança',
      );
      const release = () => repository.release(subscription.id, notice.kind, notice.windowStart);
      await release()
        .catch(() => release())
        .catch(() => {
          // A marca fica: este aviso não será reenviado (o recibo, ao contrário, é reconferido pela tarefa).
          logger.error(
            { subscriptionId: subscription.id, kind: notice.kind },
            'marca do aviso não desfeita; o aviso não será reenviado',
          );
        });
      return 'failed';
    }
  }
}

/**
 * Quando a IA volta depois do limite de uso da IA (spec 040, D3): teste gratuito, só escolhendo um plano; pago,
 * a próxima janela mensal se ela começa antes do fim do período pago (anual ou mensal estendido); senão, com a
 * renovação.
 */
export function aiResumeOf(
  subscription: Pick<SubscriptionRecord, 'status' | 'currentPeriodStart' | 'currentPeriodEnd'>,
  usageWindowStart: Date | undefined,
): AiResume {
  if (subscription.status === 'TRIAL') return { kind: 'trial' };
  if (usageWindowStart === undefined) return { kind: 'renewal' };
  const next = usageWindowEnd(usageWindowStart, subscription.currentPeriodStart);
  return next.getTime() < subscription.currentPeriodEnd.getTime()
    ? { kind: 'window', at: next }
    : { kind: 'renewal' };
}
