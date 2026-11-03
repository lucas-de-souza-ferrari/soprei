import { createHash, createHmac, randomBytes } from 'node:crypto';
import { AccountId, ClientId, type Account, type AccountRepository } from '../../domain/index.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  ServiceUnavailableError,
  UnauthorizedError,
} from '../../shared/errors/index.js';
import type { SessionStore } from '../ports/session-store.js';
import type { PasswordHasher } from '../ports/password-hasher.js';
import type { AccountSessionStore, VerificationMailer } from '../ports/account-session.js';
import type { UserIdentity } from './identity.js';
import { normalizeEmail } from './credentials.js';

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

export class AccountService {
  constructor(
    private readonly deps: {
      accounts: AccountRepository;
      passwords: PasswordHasher;
      sessions: AccountSessionStore;
      mailer: VerificationMailer;
      loginLocks: Pick<
        SessionStore,
        'loginLockState' | 'recordLoginFailure' | 'resetLoginFailures'
      >;
      loginSecret: string | Buffer;
      now?: () => Date;
    },
  ) {}

  async register(email: string, password: string): Promise<void> {
    email = normalizeEmail(email);
    // Paga o hash também para conta existente; não revela cadastro nem substitui senha.
    const hash = await this.deps.passwords.hash(password);
    if (await this.deps.accounts.findByEmail(email)) return;
    let account: Account;
    try {
      account = await this.deps.accounts.create(email, hash);
    } catch (error) {
      if (error instanceof ConflictError) return;
      throw error;
    }
    await this.sendVerification(account);
  }

  private async credentials(email: string, password: string): Promise<Account> {
    email = normalizeEmail(email);
    const key = createHmac('sha256', this.deps.loginSecret)
      .update(`account:${email}`)
      .digest('hex');
    const state = await this.deps.loginLocks.loginLockState(key);
    if (state.locked) throw new RateLimitError(state.retryAfterSeconds);
    const account = await this.deps.accounts.findByEmail(email);
    const hash = account?.passwordHash ?? (await this.deps.passwords.dummyHash());
    const valid = await this.deps.passwords.verify(password, hash);
    if (!valid || account?.status !== 'ACTIVE') {
      await this.deps.loginLocks.recordLoginFailure(key);
      throw new UnauthorizedError('Credenciais inválidas');
    }
    await this.deps.loginLocks.resetLoginFailures(key);
    return account;
  }

  async resend(email: string, password: string): Promise<void> {
    const account = await this.credentials(email, password);
    if (account.emailVerifiedAt === null) await this.sendVerification(account);
  }

  private async sendVerification(account: Account): Promise<void> {
    const token = randomBytes(32).toString('base64url');
    const now = this.deps.now?.() ?? new Date();
    await this.deps.accounts.setVerification(
      account.id,
      digest(token),
      new Date(now.getTime() + 30 * 60_000),
    );
    try {
      await this.deps.mailer.sendVerification(account.email, token);
    } catch {
      throw new ServiceUnavailableError('Não foi possível enviar a confirmação');
    }
  }

  async verify(email: string, password: string, token: string): Promise<void> {
    const account = await this.credentials(email, password);
    if (
      !(await this.deps.accounts.verify(account.id, digest(token), this.deps.now?.() ?? new Date()))
    ) {
      throw new UnauthorizedError('Confirmação inválida ou expirada');
    }
  }

  async login(email: string, password: string): Promise<string> {
    const account = await this.credentials(email, password);
    if (account.emailVerifiedAt === null)
      throw new ForbiddenError('Confirme seu e-mail antes de entrar');
    return this.deps.sessions.create(account.id);
  }

  private async session(secret: string) {
    const session = await this.deps.sessions.read(secret);
    if (session === null) throw new UnauthorizedError();
    const account = await this.deps.accounts.findById(AccountId.parse(session.accountId));
    if (account?.status !== 'ACTIVE' || account.emailVerifiedAt === null)
      throw new UnauthorizedError();
    return { session, account };
  }

  async me(secret: string) {
    const { account, session } = await this.session(secret);
    return { id: account.id, email: account.email, selectedClientId: session.clientId };
  }
  async companies(secret: string) {
    const { account } = await this.session(secret);
    return this.deps.accounts.listMemberships(account.id);
  }
  async createCompany(secret: string, name: string) {
    const { account } = await this.session(secret);
    return this.deps.accounts.createCompany(account.id, name);
  }
  async selectCompany(secret: string, id: string): Promise<void> {
    const { account } = await this.session(secret);
    const clientId = ClientId.parse(id);
    if ((await this.deps.accounts.membership(account.id, clientId)) === null)
      throw new NotFoundError('Empresa não encontrada');
    await this.deps.sessions.select(secret, clientId);
  }
  async tenantIdentity(secret: string): Promise<UserIdentity | null> {
    const { account, session } = await this.session(secret);
    if (session.clientId === null) return null;
    const member = await this.deps.accounts.membership(
      account.id,
      ClientId.parse(session.clientId),
    );
    if (member === null) throw new UnauthorizedError();
    return {
      kind: 'user',
      clientId: member.clientId,
      userId: member.userId,
      role: member.role,
      sessionId: session.id,
    };
  }
  logout(secret: string): Promise<void> {
    return this.deps.sessions.revoke(secret);
  }
}
