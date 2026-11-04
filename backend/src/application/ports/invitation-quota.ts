/**
 * Cotas anti-spam do e-mail de convite que valem **entre empresas** (spec 025, decisões 6 e 7), no
 * Redis, por HMAC (nunca o e-mail nem o id da conta em claro) e com TTL de 24 h.
 */
export interface InvitationQuotaStore {
  /** Prova que o Redis das cotas responde (criar e reenviar falham fechado, 503, antes de gravar). */
  ping(): Promise<void>;
  /**
   * Consome, de forma atômica e tudo-ou-nada, uma vaga do destinatário e (se houver) da conta
   * convidadora. `false` = alguma cota estourou: nada é consumido e o e-mail **não** deve ser enviado
   * (o convite fica gravado e a resposta ao gerenciador é a mesma).
   */
  take(recipientKey: string, accountKey: string | null): Promise<boolean>;
}
