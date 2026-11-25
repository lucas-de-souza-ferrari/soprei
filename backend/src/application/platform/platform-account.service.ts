import type { FastifyBaseLogger } from 'fastify';
import {
  type AccessStatus,
  AccountId,
  type PlatformActionReason,
  type PlatformAuditAction,
} from '../../domain/index.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import {
  ConflictError,
  NotFoundError,
  RateLimitError,
  ServiceUnavailableError,
  ValidationError,
} from '../../shared/errors/index.js';
import type { Result } from '../../shared/types/index.js';
import { isUuid } from '../../shared/utils/index.js';
import type { LoginFailure } from '../auth/auth.service.js';
import type { PlatformIdentity } from '../auth/identity.js';
import type { AccountSessionStore } from '../ports/account-session.js';
import type {
  PlatformAccountMembershipRef,
  PlatformAccountUnitOfWork,
} from '../ports/platform-account-unit-of-work.js';
import type { SessionStore } from '../ports/session-store.js';

/** Código da recusa de uma confirmação reforçada (spec 045, regra comum 3). */
export const CONFIRMATION_INVALID = 'CONFIRMATION_INVALID';

/** Conferência do código novo do autenticador (o `AuthService.confirmPlatformCode`). */
export interface PlatformActionConfirmer {
  confirmPlatformCode(
    adminId: PlatformIdentity['adminId'],
    code: string | undefined,
  ): Promise<Result<void, LoginFailure>>;
}

/** Os e-mails da 020 e da 021 disparados pelo id da conta (o `AccountService`). */
export interface PlatformAccountMail {
  requestPasswordResetFor(accountId: AccountId): Promise<void>;
  resendVerificationFor(
    accountId: AccountId,
  ): Promise<'sent' | 'ignored' | 'already_verified' | 'not_found'>;
}

export interface PlatformAccountServiceDeps {
  readonly accounts: PlatformAccountUnitOfWork;
  readonly confirmer: PlatformActionConfirmer;
  /** Sessões do cookie da conta (`revokeAll`, spec 021). */
  readonly accountSessions: Pick<AccountSessionStore, 'revokeAll'>;
  /** Sessões Bearer dos vínculos (`revokeAllSessions`, spec 007/008). */
  readonly bearerSessions: Pick<SessionStore, 'revokeAllSessions'>;
  readonly mail: PlatformAccountMail;
  readonly logger: FastifyBaseLogger;
  readonly metrics?: Pick<Metrics, 'countPlatformAction'> | undefined;
}

function accountNotFound(): NotFoundError {
  return new NotFoundError('Conta não encontrada', { context: { entity: 'Account' } });
}

type PlatformActionMetric = Parameters<Metrics['countPlatformAction']>[0];

const METRIC: Partial<Record<PlatformAuditAction, PlatformActionMetric>> = {
  ACCOUNT_DISABLED: 'account_disabled',
  ACCOUNT_ENABLED: 'account_enabled',
  ACCOUNT_SESSIONS_REVOKED: 'account_sessions_revoked',
  ACCOUNT_PASSWORD_RESET_SENT: 'account_password_reset_sent',
  ACCOUNT_VERIFICATION_SENT: 'account_verification_sent',
};

/**
 * Ações do admin da plataforma sobre uma conta (spec 045, E2): desativar e reativar, encerrar sessões,
 * enviar o código de recuperação de senha e reenviar o código de confirmação. Cada uma: trava, releitura,
 * regra, escrita e `PlatformAuditEvent` na mesma transação; o que é externo (Redis, e-mail) só depois do
 * commit. Não conhece Fastify nem Prisma. Nunca loga e-mail, código nem senha: só ids, ação e motivo.
 */
export class PlatformAccountService {
  constructor(private readonly deps: PlatformAccountServiceDeps) {}

  /**
   * Desativa (`DISABLED`, exige `code`) ou reativa (`ACTIVE`) a conta. Desativar recusa com 409
   * `LAST_OWNER` se a conta é o único dono ativo de alguma empresa ativa e não removida (regra comum 11,
   * D7). Idempotente: no estado pedido, nada é gravado. Desativar revoga, depois do commit, as sessões do
   * cookie e as Bearer de cada vínculo, também na repetição (Redis fora = 503 com a conta já desativada;
   * repetir refaz a revogação). Reativar não restaura sessões nem mexe nos vínculos. Devolve se mudou.
   */
  async setStatus(
    identity: PlatformIdentity,
    accountId: string,
    target: AccessStatus,
    reason: PlatformActionReason,
    code?: string,
  ): Promise<boolean> {
    const id = this.parseId(accountId);
    const disabling = target === 'DISABLED';
    if (disabling) await this.confirm(identity, code);
    const action: PlatformAuditAction = disabling ? 'ACCOUNT_DISABLED' : 'ACCOUNT_ENABLED';
    const outcome = await this.deps.accounts.run(async (tx) => {
      // Empresa antes de conta (regra comum 4): só desativar precisa das empresas travadas.
      if (disabling) await tx.lockOwnedCompanies(id);
      const current = await tx.lockAccount(id);
      if (current.status === target) {
        return { changed: false, memberships: disabling ? await tx.memberships(id) : [] };
      }
      if (disabling) {
        // Promoção confirmada entre a primeira leitura e a trava da conta: trava também essa empresa.
        await tx.lockOwnedCompanies(id);
        if ((await tx.soleActiveOwnerCompanies(id)) > 0) {
          throw new ConflictError('A conta é o único dono ativo de uma empresa ativa', {
            code: 'LAST_OWNER',
          });
        }
      }
      await tx.setStatus(id, target);
      await tx.audit({ adminId: identity.adminId, action, subjectAccountId: id, reason });
      return { changed: true, memberships: disabling ? await tx.memberships(id) : [] };
    });
    if (outcome.changed) this.recorded(identity, id, action, reason);
    if (disabling) await this.revokeAfterCommit(id, outcome.memberships);
    return outcome.changed;
  }

  /**
   * Encerra todas as sessões da conta: a trilha `ACCOUNT_SESSIONS_REVOKED` é gravada antes (a revogação
   * em si não é transacional); depois, `revokeAll` e as Bearer de cada vínculo. Redis fora = 503 com a
   * trilha gravada.
   */
  async revokeSessions(
    identity: PlatformIdentity,
    accountId: string,
    reason: PlatformActionReason,
  ): Promise<void> {
    const id = this.parseId(accountId);
    const action = 'ACCOUNT_SESSIONS_REVOKED';
    const memberships = await this.deps.accounts.run(async (tx) => {
      await tx.lockAccount(id);
      await tx.audit({ adminId: identity.adminId, action, subjectAccountId: id, reason });
      return tx.memberships(id);
    });
    this.recorded(identity, id, action, reason);
    await this.revokeAfterCommit(id, memberships);
  }

  /**
   * Código de recuperação de senha (D6): a trilha `ACCOUNT_PASSWORD_RESET_SENT` em todo pedido aceito
   * pela validação e, depois do commit, o mesmo caminho da 021 pelo id (mesmas travas; o resultado vai
   * só à métrica da 021). Conta não confirmada ou desativada: nada sai.
   */
  async sendPasswordReset(
    identity: PlatformIdentity,
    accountId: string,
    reason: PlatformActionReason,
  ): Promise<void> {
    const id = this.parseId(accountId);
    const action = 'ACCOUNT_PASSWORD_RESET_SENT';
    await this.deps.accounts.run(async (tx) => {
      await tx.lockAccount(id);
      await tx.audit({ adminId: identity.adminId, action, subjectAccountId: id, reason });
    });
    this.recorded(identity, id, action, reason);
    await this.deps.mail.requestPasswordResetFor(id);
  }

  /**
   * Reenvia o código de confirmação da 020, só para conta **não confirmada** (confirmada = 409
   * `ALREADY_VERIFIED`, nada gravado). O admin nunca marca o e-mail como confirmado.
   */
  async resendVerification(
    identity: PlatformIdentity,
    accountId: string,
    reason: PlatformActionReason,
  ): Promise<void> {
    const id = this.parseId(accountId);
    const action = 'ACCOUNT_VERIFICATION_SENT';
    await this.deps.accounts.run(async (tx) => {
      const account = await tx.lockAccount(id);
      if (account.verified) {
        throw new ConflictError('O e-mail da conta já está confirmado', {
          code: 'ALREADY_VERIFIED',
        });
      }
      await tx.audit({ adminId: identity.adminId, action, subjectAccountId: id, reason });
    });
    this.recorded(identity, id, action, reason);
    const result = await this.deps.mail.resendVerificationFor(id);
    this.deps.logger.info(
      { adminId: identity.adminId, accountId: id, result },
      'reenvio da confirmação pedido pela plataforma',
    );
  }

  private parseId(accountId: string): AccountId {
    if (!isUuid(accountId)) throw accountNotFound();
    return AccountId.parse(accountId);
  }

  /**
   * Confirmação reforçada (D2): código novo do autenticador do próprio admin. Sem código, a mesma recusa
   * sem consultar nada (como o formato inválido, não conta no bloqueio); errado ou já usado, a recusa e
   * uma falha no bloqueio por conta do login da plataforma; bloqueado, 429 antes de conferir.
   */
  private async confirm(identity: PlatformIdentity, code: string | undefined): Promise<void> {
    const invalid = (): ValidationError =>
      new ValidationError('Código de confirmação inválido', { code: CONFIRMATION_INVALID });
    if (code === undefined) throw invalid();
    const result = await this.deps.confirmer.confirmPlatformCode(identity.adminId, code);
    if (result.ok) return;
    switch (result.error.reason) {
      case 'locked':
        throw new RateLimitError(result.error.retryAfterSeconds);
      case 'unavailable':
        throw new ServiceUnavailableError('Serviço de autenticação indisponível');
      case 'invalid_credentials':
        throw invalid();
    }
  }

  /**
   * Revoga as sessões da conta depois do commit: o cookie (`revokeAll`) e as Bearer de cada vínculo.
   * Falha do Redis sobe como 503 com a mudança e a trilha já gravadas (repetir refaz a revogação).
   */
  private async revokeAfterCommit(
    accountId: AccountId,
    memberships: readonly PlatformAccountMembershipRef[],
  ): Promise<void> {
    try {
      await this.deps.accountSessions.revokeAll(accountId);
      for (const { companyId, membershipId } of memberships) {
        await this.deps.bearerSessions.revokeAllSessions(companyId, membershipId);
      }
    } catch (error) {
      this.deps.logger.error(
        { accountId, reason: 'revocation_failed' },
        'ação da plataforma gravada, mas a revogação das sessões falhou (repita o pedido)',
      );
      throw error;
    }
  }

  private recorded(
    identity: PlatformIdentity,
    accountId: AccountId,
    action: PlatformAuditAction,
    reason: PlatformActionReason,
  ): void {
    const metric = METRIC[action];
    try {
      if (metric !== undefined) this.deps.metrics?.countPlatformAction(metric);
    } catch (error) {
      this.deps.logger.warn({ err: error }, 'falha ao registrar métrica da plataforma');
    }
    this.deps.logger.info(
      { adminId: identity.adminId, accountId, action, reason },
      'admin da plataforma agiu sobre uma conta',
    );
  }
}
