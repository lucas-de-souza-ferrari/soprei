/** Contato com mensagens pendentes de resposta, no canal de uma empresa de uma assinatura. */
export interface PendingReplyTarget {
  readonly companyId: string;
  /** Número do negócio que a empresa usa hoje (lido do banco, nunca de job antigo). */
  readonly phoneNumberId: string;
  readonly contactRef: string;
}

/**
 * Quem tem mensagem do contato sem resposta nas empresas de uma assinatura (spec 031, E3): serve a
 * reativar a IA depois de um pagamento aprovado. Só empresas ativas, com número conectado. Limitado em
 * quantidade; o que passar do limite segue pendente e é respondido na próxima mensagem do contato.
 */
export interface PendingReplyReader {
  listForSubscription(
    subscriptionId: string,
    limit: number,
  ): Promise<readonly PendingReplyTarget[]>;
}
