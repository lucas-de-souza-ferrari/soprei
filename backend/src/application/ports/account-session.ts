export interface AccountSession {
  readonly accountId: string;
  readonly id: string;
  readonly companyId: string | null;
  readonly createdAt: number;
}

export interface AccountSessionStore {
  create(accountId: string): Promise<string>;
  read(secret: string): Promise<AccountSession | null>;
  select(secret: string, companyId: string): Promise<void>;
  revoke(secret: string): Promise<void>;
  /**
   * Invalida todas as sessões da conta (spec 021): as criadas até agora deixam de valer e a leitura
   * seguinte responde como ausente. Redis fora = `ServiceUnavailableError` (fail-closed).
   */
  revokeAll(accountId: string): Promise<void>;
}

export interface VerificationMailer {
  /** Envia o código de 6 dígitos em texto simples; nunca o loga nem o põe no assunto. */
  sendVerification(email: string, code: string): Promise<void>;
}

/** E-mails da recuperação de senha (spec 021), em texto simples. */
export interface PasswordResetMailer {
  /** Envia o código de 6 dígitos de recuperação; nunca o loga nem o põe no assunto. */
  sendPasswordReset(email: string, code: string): Promise<void>;
  /** Avisa que a senha foi alterada e as sessões encerradas; sem código, senha, IP nem link. */
  sendPasswordChanged(email: string): Promise<void>;
}

/** Aviso de conta excluída (spec 032, E7; spec 045, E6): texto fixo, sem código, senha nem link. */
export interface AccountDeletionMailer {
  sendAccountDeleted(email: string): Promise<void>;
}

/** O que o `AccountService` precisa do transporte de e-mail. */
export type AccountMailer = VerificationMailer & PasswordResetMailer;

/** Dados do e-mail de convite (spec 025). O nome da empresa ainda não está sanitizado. */
export interface CompanyInvitationMail {
  readonly companyName: string;
  /** `OWNER` só no convite da plataforma (spec 045, E3b). */
  readonly role: 'OWNER' | 'ADMIN' | 'AGENT' | 'VIEWER';
  /** `${APP_ORIGIN}/convite#t=...`: nunca vai a log. */
  readonly link: string;
  readonly validDays: number;
}

/** E-mail de convite para a equipe de uma empresa (spec 025), em texto simples. */
export interface InvitationMailer {
  /** Assunto fixo, sem nome da empresa; falha com erro fixo, sem eco de destinatário nem de link. */
  sendCompanyInvitation(email: string, mail: CompanyInvitationMail): Promise<void>;
}
