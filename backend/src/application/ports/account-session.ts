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

/** O que o `AccountService` precisa do transporte de e-mail. */
export type AccountMailer = VerificationMailer & PasswordResetMailer;
