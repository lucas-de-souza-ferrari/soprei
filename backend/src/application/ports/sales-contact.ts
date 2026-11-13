/** E-mail de contato comercial já montado (spec 040, E4): assunto fixo, texto simples e o `Reply-To`. */
export interface SalesContactMail {
  readonly subject: string;
  readonly text: string;
  /** E-mail do interessado, já validado (sem quebra de linha nem espaço); vai sem nome de exibição. */
  readonly replyTo: string;
}

export interface SalesContactMailer {
  /** Falha com erro fixo, sem eco de destinatário, texto nem `Reply-To`. */
  sendSalesContact(to: string, mail: SalesContactMail): Promise<void>;
}

/**
 * Teto global diário de e-mails de contato comercial (spec 040, D13). `take` conta um envio no dia (UTC,
 * `AAAA-MM-DD`) e diz se ele cabe no teto. Indisponível = `ServiceUnavailableError` (fail-closed: nada é
 * enviado sem o teto).
 */
export interface SalesContactDailyCap {
  take(day: string): Promise<boolean>;
}
