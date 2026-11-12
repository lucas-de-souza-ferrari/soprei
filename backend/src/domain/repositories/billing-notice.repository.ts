import type { BillingNoticeKind, NoticeSubject } from '../billing-notices.js';
import type { SubscriptionRecord } from '../billing.js';

/**
 * Quem recebe o aviso: o titular da assinatura, só se a conta está ativa e com o e-mail confirmado. O
 * endereço existe só em memória de quem envia (nunca vai a log, métrica nem a outra camada).
 */
export interface NoticeRecipient {
  readonly email: string;
}

export interface NoticeCandidate extends NoticeSubject {
  /** `null`: conta desativada ou sem e-mail confirmado (nada é enviado). */
  readonly recipient: NoticeRecipient | null;
}

/** Dados de uma assinatura para o aviso disparado por um evento (pagamento). */
export interface NoticeTarget {
  readonly subscription: SubscriptionRecord;
  readonly recipient: NoticeRecipient | null;
}

/** Pagamento concedido cujo recibo ainda não foi marcado. */
export interface PendingReceipt {
  readonly subscriptionId: string;
  readonly paidAt: Date;
}

/**
 * Avisos por e-mail (spec 031, E5). Models globais: só se lê por lote de assinaturas ou pelo id da própria
 * assinatura; nenhuma rota passa por aqui. `claim` é a trava de "uma vez por ciclo e tipo": a chave única
 * (assinatura, tipo, janela) decide a corrida entre duas execuções do timer.
 */
export interface BillingNoticeRepository {
  /** Lote de assinaturas ainda não vencidas de vez (EXPIRED fica fora), em ordem de id, depois de `after`. */
  listBatch(now: Date, after: string | null, limit: number): Promise<readonly NoticeCandidate[]>;
  /** Pagamentos concedidos desde `since` sem a marca do recibo (PAYMENT_RECEIVED na janela do instante do pagamento). */
  listPendingReceipts(since: Date, limit: number): Promise<readonly PendingReceipt[]>;
  findTarget(subscriptionId: string): Promise<NoticeTarget | null>;
  /** Marca o aviso como enviado; falso se já estava marcado (quem perde a corrida não envia). */
  claim(subscriptionId: string, kind: BillingNoticeKind, windowStart: Date): Promise<boolean>;
  /** Desfaz a marca quando o envio falhou, para a próxima execução tentar de novo. */
  release(subscriptionId: string, kind: BillingNoticeKind, windowStart: Date): Promise<void>;
  /** Grava o estado derivado do tempo, só se a linha ainda é a que foi lida (nada de apagar). */
  syncStatus(
    subscription: Pick<SubscriptionRecord, 'id' | 'status' | 'currentPeriodEnd'>,
    next: 'PAST_DUE' | 'EXPIRED',
  ): Promise<boolean>;
}
