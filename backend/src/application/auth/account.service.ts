import { createHmac, randomUUID } from 'node:crypto';
import {
  AccountId,
  CompanyId,
  type Account,
  type AccountMembership,
  type AccountRepository,
  type Permission,
  ROLE_PERMISSIONS,
  type ResetFailureOutcome,
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
import type { AccountMailer, AccountSessionStore } from '../ports/account-session.js';
import type { MembershipIdentity } from './identity.js';
import { pickCompanyToOpen } from './company-pick.js';
import { normalizeEmail } from './credentials.js';
import { deriveResetKey, resetDigest } from './reset-code.js';
import {
  deriveVerificationKey,
  generateVerificationCode,
  verificationDigest,
  type RandomInt,
} from './verification-code.js';

const VERIFICATION_TTL_MS = 15 * 60_000;
const VERIFICATION_MIN_INTERVAL_MS = 60_000;
/** Código de recuperação de senha (spec 021): mesma validade e intervalo do de confirmação. */
const RESET_TTL_MS = 15 * 60_000;
const RESET_MIN_INTERVAL_MS = 60_000;

/** Resposta uniforme de qualquer falha do código de recuperação (a razão vai só ao observador). */
const RESET_INVALID_MESSAGE = 'Código inválido ou expirado';

/** Vínculo da conta com as permissões do papel (spec 023): campo aditivo, só leitura para o site. */
export type AccountMembershipView = AccountMembership & {
  readonly permissions: readonly Permission[];
};

function withPermissions(membership: AccountMembership): AccountMembershipView {
  return { ...membership, permissions: [...ROLE_PERMISSIONS[membership.role]] };
}

export type PasswordResetResult = ResetFailureOutcome | 'reset' | 'revoke_failed';

export class AccountService {
  constructor(
    private readonly deps: {
      accounts: AccountRepository;
      passwords: PasswordHasher;
      sessions: AccountSessionStore;
      mailer: AccountMailer;
      loginLocks: Pick<
        SessionStore,
        'loginLockState' | 'recordLoginFailure' | 'resetLoginFailures'
      >;
      loginSecret: string | Buffer;
      now?: () => Date;
      /**
       * Cobrança (spec 031): só com `BILLING_ENABLED`. Presente, a criação de empresa confere acesso e limite
       * do plano e liga a empresa à assinatura da conta; ausente, o comportamento é o de sempre.
       */
      billing?: { readonly trialDays: number; readonly graceDays: number };
      /** Fonte do código de 6 dígitos (padrão: `crypto.randomInt`); os testes injetam valores. */
      randomInt?: RandomInt;
      /** Resultado do envio em segundo plano; só id e resultado, nunca e-mail nem código. */
      onVerificationMail?: (result: 'sent' | 'failed', accountId: string) => void;
      /** Resultado de cada tentativa de confirmar; só id e resultado, nunca código, hash nem e-mail. */
      onVerificationAttempt?: (result: VerifyOutcome, accountId: string) => void;
      /** Pedido de código de recuperação: gravou ("issued") ou foi ignorado; nunca e-mail nem código. */
      onPasswordResetRequest?: (result: 'issued' | 'ignored') => void;
      /** Resultado de cada tentativa de redefinir; `accountId` só quando já se conhece a conta. */
      onPasswordReset?: (result: PasswordResetResult, accountId?: string) => void;
      /** Resultado do e-mail da recuperação em segundo plano (código ou aviso); só id e resultado. */
      onPasswordResetMail?: (
        kind: 'code' | 'notice',
        result: 'sent' | 'failed',
        accountId: string,
      ) => void;
      /** Aviso operacional que não derruba a operação (só id da conta, nunca e-mail). */
      onWarning?: (
        event: 'login_lock_reset_failed' | 'preselect_failed' | 'last_company_failed',
        accountId: string,
      ) => void;
    },
  ) {
    this.verificationKey = deriveVerificationKey(deps.loginSecret);
    this.resetKey = deriveResetKey(deps.loginSecret);
  }

  private readonly verificationKey: Buffer;
  private readonly resetKey: Buffer;

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

  private resetHash(email: string, code: string): string {
    return resetDigest(this.resetKey, email, code);
  }

  /** Registra uma tarefa em segundo plano (esperada no desligamento); nunca rejeita. */
  private background(work: () => Promise<void>): void {
    const task: Promise<void> = work()
      .catch(() => undefined)
      .finally(() => {
        this.pending.delete(task);
      });
    this.pending.add(task);
  }

  private observe(call: () => void): void {
    try {
      call();
    } catch {
      // Observabilidade nunca derruba o processo.
    }
  }

  /**
   * Pedido de código de recuperação (spec 021). Responde igual para qualquer e-mail: o trabalho de
   * banco é o mesmo (um UPDATE condicional) e o envio roda em segundo plano. Só conta confirmada e
   * ativa, fora do intervalo de 60 s e do teto diário de erros, grava código e recebe e-mail.
   */
  async requestPasswordReset(email: string): Promise<void> {
    email = normalizeEmail(email);
    const code = generateVerificationCode(this.deps.randomInt);
    const now = this.now();
    const hash = this.resetHash(email, code);
    const id = await this.deps.accounts.issueResetCode(
      email,
      hash,
      new Date(now.getTime() + RESET_TTL_MS),
      new Date(now.getTime() + RESET_TTL_MS - RESET_MIN_INTERVAL_MS),
      now,
    );
    this.observe(() => this.deps.onPasswordResetRequest?.(id === null ? 'ignored' : 'issued'));
    if (id === null) return;
    this.background(async () => {
      let result: 'sent' | 'failed' = 'sent';
      try {
        await this.deps.mailer.sendPasswordReset(email, code);
      } catch {
        result = 'failed';
        // O código não saiu: libera um novo pedido já (melhor esforço).
        await this.deps.accounts.clearResetCode(id, hash).catch(() => undefined);
      }
      this.observe(() => this.deps.onPasswordResetMail?.('code', result, id));
    });
  }

  /**
   * Código de recuperação pedido pelo admin da plataforma (spec 045, E2, D6): o e-mail é lido pelo id e o
   * pedido segue **o mesmo caminho** de `requestPasswordReset` (mesmas travas: só conta confirmada e ativa,
   * 60 s entre pedidos, teto diário de erros; envio em segundo plano). O admin nunca vê código nem senha.
   * Conta inexistente: nada acontece (quem chama já conferiu a existência).
   */
  async requestPasswordResetFor(accountId: AccountId): Promise<void> {
    const account = await this.deps.accounts.findById(accountId);
    if (account === null) return;
    await this.requestPasswordReset(account.email);
  }

  /**
   * Reenvio do código de confirmação pelo admin da plataforma (spec 045, E2): pelo id da conta, sem a
   * senha da pessoa, com o mesmo intervalo de 60 s e o mesmo teto diário de erros da 020
   * (`refreshVerification`); o envio roda em segundo plano. `already_verified`: conta confirmada (nada
   * muda); `ignored`: barrado pelas travas ou conta desativada (nada sai).
   */
  async resendVerificationFor(
    accountId: AccountId,
  ): Promise<'sent' | 'ignored' | 'already_verified' | 'not_found'> {
    const account = await this.deps.accounts.findById(accountId);
    if (account === null) return 'not_found';
    if (account.emailVerifiedAt !== null) return 'already_verified';
    const code = generateVerificationCode(this.deps.randomInt);
    const now = this.now();
    const stored = await this.deps.accounts.refreshVerification(
      account.id,
      this.digest(account.email, code),
      new Date(now.getTime() + VERIFICATION_TTL_MS),
      this.retryBefore(now),
      now,
    );
    if (!stored) return 'ignored';
    this.deliver(account.id, account.email, code);
    return 'sent';
  }

  private resetFailure(result: PasswordResetResult, accountId?: string): UnauthorizedError {
    this.observe(() => this.deps.onPasswordReset?.(result, accountId));
    return new UnauthorizedError(RESET_INVALID_MESSAGE);
  }

  /**
   * Redefine a senha com o código de 6 dígitos (spec 021; o formato e a política da senha são do
   * controller, antes daqui). O hash da senha só é pago depois de o código ser conferido (leitura
   * sem consumir); a troca e a morte do código são uma só instrução. As sessões da conta são
   * revogadas antes e depois do commit. Sem login automático. Toda falha do código é a mesma 401.
   */
  async confirmPasswordReset(email: string, code: string, newPassword: string): Promise<void> {
    email = normalizeEmail(email);
    const hash = this.resetHash(email, code);
    const reject = async (accountId?: string): Promise<never> => {
      const outcome = await this.deps.accounts.recordResetFailure(email, this.now());
      throw this.resetFailure(outcome, accountId);
    };
    if (!(await this.deps.accounts.hasValidResetCode(email, hash, this.now()))) return reject();
    const passwordHash = await this.deps.passwords.hash(newPassword);
    const account = await this.deps.accounts.findByEmail(email);
    if (account === null) return reject();
    // Revogação antes do commit: se falhar, nada foi gravado e o código segue válido.
    try {
      await this.deps.sessions.revokeAll(account.id);
    } catch (error) {
      this.observe(() => this.deps.onPasswordReset?.('revoke_failed', account.id));
      throw error;
    }
    const changed = await this.deps.accounts.resetPassword(email, hash, passwordHash, this.now());
    if (!changed) return reject(account.id);
    this.observe(() => this.deps.onPasswordReset?.('reset', account.id));
    // Revogação depois do commit: fecha a janela de uma sessão criada com a senha antiga entre a
    // revogação prévia e a troca. Falha = 503 com a senha já trocada e o código gasto.
    try {
      await this.deps.sessions.revokeAll(account.id);
    } catch (error) {
      this.observe(() => this.deps.onPasswordReset?.('revoke_failed', account.id));
      throw error;
    }
    try {
      await this.deps.loginLocks.resetLoginFailures(this.lockKey(email));
    } catch {
      this.observe(() => this.deps.onWarning?.('login_lock_reset_failed', account.id));
    }
    this.background(async () => {
      let result: 'sent' | 'failed' = 'sent';
      try {
        await this.deps.mailer.sendPasswordChanged(email);
      } catch {
        result = 'failed';
      }
      this.observe(() => this.deps.onPasswordResetMail?.('notice', result, account.id));
    });
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

  /** Chave do bloqueio de login por conta (HMAC do e-mail; vale também para contas inexistentes). */
  private lockKey(email: string): string {
    return createHmac('sha256', this.deps.loginSecret).update(`account:${email}`).digest('hex');
  }

  private async credentials(email: string, password: string): Promise<Account> {
    email = normalizeEmail(email);
    const key = this.lockKey(email);
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
    const secret = await this.deps.sessions.create(account.id);
    await this.preselectCompany(secret, account.id);
    return secret;
  }

  /**
   * Abre a empresa já no login (spec 029): a última usada, se a conta ainda tem vínculo ativo nela e a empresa
   * está ativa; senão a primeira da lista (que é a única, quando há uma só). Melhor esforço: qualquer falha
   * deixa a sessão sem empresa, como antes, e nunca derruba o login. A dica é só leitura da própria conta
   * e é conferida contra a lista de vínculos ativos (`listMemberships`) antes de ser usada.
   */
  private async preselectCompany(secret: string, accountId: AccountId): Promise<void> {
    try {
      const memberships = await this.deps.accounts.listMemberships(accountId);
      if (memberships.length === 0) return;
      const target = pickCompanyToOpen(
        memberships,
        await this.deps.accounts.lastCompanyId(accountId),
      );
      if (target !== null) await this.deps.sessions.select(secret, target);
    } catch {
      this.observe(() => this.deps.onWarning?.('preselect_failed', accountId));
    }
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
    return { id: account.id, email: account.email, selectedCompanyId: session.companyId };
  }
  async companies(secret: string) {
    const { account } = await this.session(secret);
    // `permissions` (spec 023) é derivado do mapa fixo no servidor; o site só o usa para mostrar abas.
    return (await this.deps.accounts.listMemberships(account.id)).map(withPermissions);
  }
  async createCompany(secret: string, name: string) {
    const { account } = await this.session(secret);
    const { billing } = this.deps;
    const created = await this.deps.accounts.createCompany(
      account.id,
      name,
      billing === undefined ? undefined : { ...billing, now: this.now() },
    );
    return withPermissions(created);
  }
  async selectCompany(secret: string, id: string): Promise<void> {
    const { account } = await this.session(secret);
    const companyId = CompanyId.parse(id);
    if ((await this.deps.accounts.membership(account.id, companyId)) === null)
      throw new NotFoundError('Empresa não encontrada');
    await this.deps.sessions.select(secret, companyId);
    // Dica da última empresa (spec 029): melhor esforço, nunca falha a seleção já feita.
    try {
      await this.deps.accounts.setLastCompany(account.id, companyId);
    } catch {
      this.observe(() => this.deps.onWarning?.('last_company_failed', account.id));
    }
  }
  async tenantIdentity(secret: string): Promise<MembershipIdentity | null> {
    const { account, session } = await this.session(secret);
    if (session.companyId === null) return null;
    const member = await this.deps.accounts.membership(
      account.id,
      CompanyId.parse(session.companyId),
    );
    if (member === null) throw new UnauthorizedError();
    return {
      kind: 'membership',
      companyId: member.companyId,
      membershipId: member.membershipId,
      role: member.role,
      sessionId: session.id,
    };
  }
  logout(secret: string): Promise<void> {
    return this.deps.sessions.revoke(secret);
  }
}
