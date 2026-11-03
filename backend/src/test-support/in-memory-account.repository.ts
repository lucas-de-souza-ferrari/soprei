import { randomUUID } from 'node:crypto';
import {
  AccountId,
  RESET_DAILY_FAILURE_CAP,
  RESET_FAILURE_WINDOW_MS,
  RESET_MAX_ATTEMPTS,
  VERIFICATION_DAILY_FAILURE_CAP,
  VERIFICATION_FAILURE_WINDOW_MS,
  VERIFICATION_MAX_ATTEMPTS,
  type Account,
  type AccountMembership,
  type AccountRepository,
  type ResetFailureOutcome,
  type VerifyOutcome,
} from '../domain/index.js';

/** Estado de uma conta como as colunas do banco (o contrato é o mesmo do repositório do Postgres). */
export interface MemoryAccountRow {
  id: string;
  email: string;
  passwordHash: string;
  status: 'ACTIVE' | 'DISABLED';
  emailVerifiedAt: Date | null;
  verificationHash: string | null;
  verificationExpiresAt: Date | null;
  verificationAttempts: number;
  verificationFailuresDay: number;
  verificationFailuresSince: Date | null;
  resetHash: string | null;
  resetExpiresAt: Date | null;
  resetAttempts: number;
  resetFailuresDay: number;
  resetFailuresSince: Date | null;
}

/**
 * `AccountRepository` em memória com a mesma semântica das instruções SQL do repositório real
 * (cada método é síncrono por dentro, como um UPDATE atômico). Só cobre o que a confirmação de
 * e-mail usa; vínculos e empresas não existem aqui.
 */
export class InMemoryAccountRepository implements AccountRepository {
  private readonly rows = new Map<string, MemoryAccountRow>();

  private static cap(row: MemoryAccountRow, now: Date): boolean {
    const windowStart = now.getTime() - VERIFICATION_FAILURE_WINDOW_MS;
    return (
      row.verificationFailuresSince !== null &&
      row.verificationFailuresSince.getTime() > windowStart &&
      row.verificationFailuresDay >= VERIFICATION_DAILY_FAILURE_CAP
    );
  }

  private view(row: MemoryAccountRow): Account {
    return {
      id: AccountId.parse(row.id),
      email: row.email,
      passwordHash: row.passwordHash,
      status: row.status,
      emailVerifiedAt: row.emailVerifiedAt,
    };
  }

  private byEmail(email: string): MemoryAccountRow | undefined {
    return [...this.rows.values()].find((row) => row.email === email);
  }

  /** Atalho dos testes: cópia do estado da conta (sem expor a referência interna). */
  peek(email: string): MemoryAccountRow {
    const row = this.byEmail(email);
    if (row === undefined) throw new Error('conta inexistente no repositório em memória');
    return { ...row };
  }

  /** Atalho dos testes: força campos (ex.: simular erros acumulados em outra janela). */
  patch(email: string, changes: Partial<MemoryAccountRow>): void {
    const row = this.byEmail(email);
    if (row === undefined) throw new Error('conta inexistente no repositório em memória');
    Object.assign(row, changes);
  }

  private blank(id: string, email: string, passwordHash: string): MemoryAccountRow {
    return {
      id,
      email,
      passwordHash,
      status: 'ACTIVE',
      emailVerifiedAt: null,
      verificationHash: null,
      verificationExpiresAt: null,
      verificationAttempts: 0,
      verificationFailuresDay: 0,
      verificationFailuresSince: null,
      resetHash: null,
      resetExpiresAt: null,
      resetAttempts: 0,
      resetFailuresDay: 0,
      resetFailuresSince: null,
    };
  }

  findByEmail(email: string): Promise<Account | null> {
    const row = this.byEmail(email);
    return Promise.resolve(row === undefined ? null : this.view(row));
  }

  findById(id: AccountId): Promise<Account | null> {
    const row = this.rows.get(id);
    return Promise.resolve(row === undefined ? null : this.view(row));
  }

  create(email: string, passwordHash: string): Promise<Account> {
    if (this.byEmail(email) !== undefined) return Promise.reject(new Error('e-mail repetido'));
    const id = randomUUID();
    const row = this.blank(id, email, passwordHash);
    this.rows.set(id, row);
    return Promise.resolve(this.view(row));
  }

  registerUnverified(input: {
    readonly id: string;
    readonly email: string;
    readonly passwordHash: string;
    readonly verificationHash: string;
    readonly expiresAt: Date;
    readonly retryBefore: Date;
    readonly now: Date;
  }): Promise<string | null> {
    const existing = this.byEmail(input.email);
    if (existing === undefined) {
      const row = this.blank(input.id, input.email, input.passwordHash);
      row.verificationHash = input.verificationHash;
      row.verificationExpiresAt = input.expiresAt;
      this.rows.set(row.id, row);
      return Promise.resolve(row.id);
    }
    if (
      existing.emailVerifiedAt !== null ||
      existing.status !== 'ACTIVE' ||
      (existing.verificationExpiresAt !== null &&
        existing.verificationExpiresAt.getTime() > input.retryBefore.getTime()) ||
      InMemoryAccountRepository.cap(existing, input.now)
    ) {
      return Promise.resolve(null);
    }
    existing.passwordHash = input.passwordHash;
    existing.verificationHash = input.verificationHash;
    existing.verificationExpiresAt = input.expiresAt;
    existing.verificationAttempts = 0;
    return Promise.resolve(existing.id);
  }

  refreshVerification(
    id: string,
    hash: string,
    expiresAt: Date,
    retryBefore: Date,
    now: Date,
  ): Promise<boolean> {
    const row = this.rows.get(id);
    if (
      row === undefined ||
      row.emailVerifiedAt !== null ||
      row.status !== 'ACTIVE' ||
      (row.verificationExpiresAt !== null &&
        row.verificationExpiresAt.getTime() > retryBefore.getTime()) ||
      InMemoryAccountRepository.cap(row, now)
    ) {
      return Promise.resolve(false);
    }
    row.verificationHash = hash;
    row.verificationExpiresAt = expiresAt;
    row.verificationAttempts = 0;
    return Promise.resolve(true);
  }

  clearVerification(id: string, hash: string): Promise<void> {
    const row = this.rows.get(id);
    if (row !== undefined && row.verificationHash === hash && row.emailVerifiedAt === null) {
      row.verificationHash = null;
      row.verificationExpiresAt = null;
      row.verificationAttempts = 0;
    }
    return Promise.resolve();
  }

  setVerification(id: string, hash: string, expiresAt: Date): Promise<void> {
    const row = this.rows.get(id);
    if (row === undefined) return Promise.reject(new Error('conta inexistente'));
    row.verificationHash = hash;
    row.verificationExpiresAt = expiresAt;
    row.verificationAttempts = 0;
    return Promise.resolve();
  }

  verify(id: string, hash: string, now: Date): Promise<VerifyOutcome> {
    const row = this.rows.get(id);
    if (row === undefined) return Promise.resolve('unavailable');
    const live =
      row.verificationHash !== null &&
      row.verificationExpiresAt !== null &&
      row.verificationExpiresAt.getTime() > now.getTime() &&
      row.status === 'ACTIVE' &&
      row.emailVerifiedAt === null;
    if (!live) return Promise.resolve('unavailable');
    if (row.verificationHash === hash && row.verificationAttempts < VERIFICATION_MAX_ATTEMPTS) {
      row.emailVerifiedAt = now;
      row.verificationHash = null;
      row.verificationExpiresAt = null;
      row.verificationAttempts = 0;
      row.verificationFailuresDay = 0;
      row.verificationFailuresSince = null;
      return Promise.resolve('verified');
    }
    const windowStart = now.getTime() - VERIFICATION_FAILURE_WINDOW_MS;
    const freshWindow =
      row.verificationFailuresSince === null ||
      row.verificationFailuresSince.getTime() <= windowStart;
    const day = freshWindow ? 1 : row.verificationFailuresDay + 1;
    row.verificationAttempts += 1;
    row.verificationFailuresDay = day;
    if (freshWindow) row.verificationFailuresSince = now;
    if (
      row.verificationAttempts >= VERIFICATION_MAX_ATTEMPTS ||
      day >= VERIFICATION_DAILY_FAILURE_CAP
    ) {
      row.verificationHash = null;
      return Promise.resolve('exhausted');
    }
    return Promise.resolve('wrong');
  }

  private static resetCap(row: MemoryAccountRow, now: Date): boolean {
    const windowStart = now.getTime() - RESET_FAILURE_WINDOW_MS;
    return (
      row.resetFailuresSince !== null &&
      row.resetFailuresSince.getTime() > windowStart &&
      row.resetFailuresDay >= RESET_DAILY_FAILURE_CAP
    );
  }

  /** Conta apta a recuperar a senha: confirmada e ativa (o mesmo predicado das instruções SQL). */
  private static eligible(row: MemoryAccountRow): boolean {
    return row.status === 'ACTIVE' && row.emailVerifiedAt !== null;
  }

  issueResetCode(
    email: string,
    hash: string,
    expiresAt: Date,
    retryBefore: Date,
    now: Date,
  ): Promise<string | null> {
    const row = this.byEmail(email);
    if (
      row === undefined ||
      !InMemoryAccountRepository.eligible(row) ||
      (row.resetExpiresAt !== null && row.resetExpiresAt.getTime() > retryBefore.getTime()) ||
      InMemoryAccountRepository.resetCap(row, now)
    ) {
      return Promise.resolve(null);
    }
    row.resetHash = hash;
    row.resetExpiresAt = expiresAt;
    row.resetAttempts = 0;
    return Promise.resolve(row.id);
  }

  hasValidResetCode(email: string, hash: string, now: Date): Promise<boolean> {
    const row = this.byEmail(email);
    return Promise.resolve(
      row !== undefined &&
        InMemoryAccountRepository.eligible(row) &&
        row.resetHash === hash &&
        row.resetExpiresAt !== null &&
        row.resetExpiresAt.getTime() > now.getTime() &&
        row.resetAttempts < RESET_MAX_ATTEMPTS,
    );
  }

  recordResetFailure(email: string, now: Date): Promise<ResetFailureOutcome> {
    const row = this.byEmail(email);
    if (
      row === undefined ||
      !InMemoryAccountRepository.eligible(row) ||
      row.resetHash === null ||
      row.resetExpiresAt === null ||
      row.resetExpiresAt.getTime() <= now.getTime()
    ) {
      return Promise.resolve('unavailable');
    }
    const windowStart = now.getTime() - RESET_FAILURE_WINDOW_MS;
    const fresh =
      row.resetFailuresSince === null || row.resetFailuresSince.getTime() <= windowStart;
    const day = fresh ? 1 : row.resetFailuresDay + 1;
    row.resetAttempts += 1;
    row.resetFailuresDay = day;
    if (fresh) row.resetFailuresSince = now;
    if (row.resetAttempts >= RESET_MAX_ATTEMPTS || day >= RESET_DAILY_FAILURE_CAP) {
      row.resetHash = null;
      return Promise.resolve('exhausted');
    }
    return Promise.resolve('wrong');
  }

  resetPassword(email: string, hash: string, passwordHash: string, now: Date): Promise<boolean> {
    const row = this.byEmail(email);
    if (
      row === undefined ||
      !InMemoryAccountRepository.eligible(row) ||
      row.resetHash !== hash ||
      row.resetExpiresAt === null ||
      row.resetExpiresAt.getTime() <= now.getTime() ||
      row.resetAttempts >= RESET_MAX_ATTEMPTS
    ) {
      return Promise.resolve(false);
    }
    row.passwordHash = passwordHash;
    row.resetHash = null;
    row.resetExpiresAt = null;
    row.resetAttempts = 0;
    row.resetFailuresDay = 0;
    row.resetFailuresSince = null;
    return Promise.resolve(true);
  }

  clearResetCode(id: string, hash: string): Promise<void> {
    const row = this.rows.get(id);
    if (row !== undefined && row.resetHash === hash) {
      row.resetHash = null;
      row.resetExpiresAt = null;
      row.resetAttempts = 0;
    }
    return Promise.resolve();
  }

  listMemberships(): Promise<readonly AccountMembership[]> {
    return Promise.reject(new Error('não suportado no repositório em memória'));
  }

  membership(): Promise<AccountMembership | null> {
    return Promise.reject(new Error('não suportado no repositório em memória'));
  }

  createCompany(): Promise<AccountMembership> {
    return Promise.reject(new Error('não suportado no repositório em memória'));
  }
}
