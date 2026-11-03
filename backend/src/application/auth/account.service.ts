import { createHmac, randomUUID } from 'node:crypto';
import {
  AccountId,
  ClientId,
  type Account,
  type AccountRepository,
  type VerifyOutcome,
} from '../../domain/index.js';
import {
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
import {
  deriveVerificationKey,
  generateVerificationCode,
  verificationDigest,
  type RandomInt,
} from './verification-code.js';

const VERIFICATION_TTL_MS = 15 * 60_000;
const VERIFICATION_MIN_INTERVAL_MS = 60_000;

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
      /** Fonte do código de 6 dígitos (padrão: `crypto.randomInt`); os testes injetam valores. */
      randomInt?: RandomInt;
      /** Resultado do envio em segundo plano; só id e resultado, nunca e-mail nem código. */
      onVerificationMail?: (result: 'sent' | 'failed', accountId: string) => void;
      /** Resultado de cada tentativa de confirmar; só id e resultado, nunca código, hash nem e-mail. */
      onVerificationAttempt?: (result: VerifyOutcome, accountId: string) => void;
    },
  ) {
    this.verificationKey = deriveVerificationKey(deps.loginSecret);
  }

  private readonly verificationKey: Buffer;

  /** Envios de confirmação em segundo plano ainda não concluídos (esperados no desligamento). */
  private readonly pending = new Set<Promise<void>>();

  /**
   * Cadastro público. Responde igual para e-mail novo, não confirmado e já confirmado, e o envio
   * do código roda depois, em segundo plano (nem o tempo nem uma falha de SMTP revelam se o
   * e-mail existe). Conta ainda não confirmada: quem se cadastra de novo (o dono real do e-mail)
   * substitui a senha e recebe um código novo, que invalida o anterior; sem o código enviado ao
   * e-mail ninguém confirma nem entra. Conta confirmada nunca muda.
   */
  async register(email: string, password: string): Promise<void> {
    email = normalizeEmail(email);
    // O hash é pago em qualquer caso, antes de olhar o banco.
    const hash = await this.deps.passwords.hash(password);
    const code = generateVerificationCode(this.deps.randomInt);
    const now = this.now();
    const id = await this.deps.accounts.registerUnverified({
      id: randomUUID(),
      email,
      passwordHash: hash,
      verificationHash: this.digest(email, code),
      expiresAt: new Date(now.getTime() + VERIFICATION_TTL_MS),
      retryBefore: this.retryBefore(now),
      now,
    });
    if (id !== null) this.deliver(id, email, code);
  }

  /** Espera os envios pendentes (desligamento); nunca rejeita. */
  async drain(timeoutMs = 10_000): Promise<void> {
    if (this.pending.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([Promise.allSettled([...this.pending]).then(() => undefined), limit]);
    } finally {
      clearTimeout(timer);
    }
  }

  private digest(email: string, code: string): string {
    return verificationDigest(this.verificationKey, email, code);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Só se pode reenviar/substituir se o último envio foi há pelo menos o intervalo mínimo. */
  private retryBefore(now: Date): Date {
    return new Date(now.getTime() + VERIFICATION_TTL_MS - VERIFICATION_MIN_INTERVAL_MS);
  }

  private deliver(accountId: string, email: string, code: string): void {
    const task: Promise<void> = (async () => {
      let result: 'sent' | 'failed' = 'sent';
      try {
        await this.deps.mailer.sendVerification(email, code);
      } catch {
        result = 'failed';
        // O código não saiu: libera um novo envio já (melhor esforço).
        await this.deps.accounts
          .clearVerification(accountId, this.digest(email, code))
          .catch(() => undefined);
      }
      try {
        this.deps.onVerificationMail?.(result, accountId);
      } catch {
        // Observabilidade nunca derruba o processo.
      }
    })().finally(() => {
      this.pending.delete(task);
    });
    this.pending.add(task);
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
    if (account.emailVerifiedAt !== null) return;
    const code = generateVerificationCode(this.deps.randomInt);
    const now = this.now();
    const stored = await this.deps.accounts.refreshVerification(
      account.id,
      this.digest(account.email, code),
      new Date(now.getTime() + VERIFICATION_TTL_MS),
      this.retryBefore(now),
      now,
    );
    // Intervalo mínimo desde o último envio e teto diário de erros: pedido barrado responde igual
    // e não envia.
    if (!stored) return;
    try {
      await this.deps.mailer.sendVerification(account.email, code);
    } catch {
      await this.deps.accounts
        .clearVerification(account.id, this.digest(account.email, code))
        .catch(() => undefined);
      throw new ServiceUnavailableError('Não foi possível enviar a confirmação');
    }
  }

  /**
   * Confirma o e-mail com o código de 6 dígitos (a validação do formato é do controller, antes
   * daqui). Só senha correta e conta ativa chegam à comparação; senha errada segue no bloqueio por
   * conta e nunca conta como erro do código. Código errado, vencido, esgotado ou inexistente e conta
   * já confirmada respondem a mesma 401; o resultado detalhado vai só ao observador.
   */
  async verify(email: string, password: string, code: string): Promise<void> {
    const account = await this.credentials(email, password);
    const outcome = await this.deps.accounts.verify(
      account.id,
      this.digest(account.email, code),
      this.now(),
    );
    try {
      this.deps.onVerificationAttempt?.(outcome, account.id);
    } catch {
      // Observabilidade nunca derruba o processo.
    }
    if (outcome !== 'verified') throw new UnauthorizedError('Confirmação inválida ou expirada');
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
