/** E-mail de aviso de cobrança já montado pela aplicação (spec 031, E5): assunto fixo e texto simples. */
export interface BillingNoticeMail {
  readonly subject: string;
  readonly text: string;
}

export interface BillingMailer {
  /** Falha com erro fixo, sem eco de destinatário, texto nem link. */
  sendBillingNotice(email: string, mail: BillingNoticeMail): Promise<void>;
}
