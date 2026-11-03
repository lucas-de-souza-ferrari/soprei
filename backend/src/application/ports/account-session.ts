export interface AccountSession {
  readonly accountId: string;
  readonly id: string;
  readonly clientId: string | null;
  readonly createdAt: number;
}

export interface AccountSessionStore {
  create(accountId: string): Promise<string>;
  read(secret: string): Promise<AccountSession | null>;
  select(secret: string, clientId: string): Promise<void>;
  revoke(secret: string): Promise<void>;
}

export interface VerificationMailer {
  sendVerification(email: string, token: string): Promise<void>;
}
