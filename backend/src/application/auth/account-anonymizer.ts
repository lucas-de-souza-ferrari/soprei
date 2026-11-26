import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import {
  type AccountId,
  anonymizedEmailFor,
  isAnonymizedEmail,
  type NewPlatformAuditEvent,
} from '../../domain/index.js';
import { ConflictError, NotFoundError } from '../../shared/errors/index.js';
import type { AccountDeletionMailer, AccountSessionStore } from '../ports/account-session.js';
import type {
  AccountAnonymizationTransaction,
  AccountAnonymizationUnitOfWork,
  AnonymizedMembershipRef,
} from '../ports/account-anonymization-unit-of-work.js';
import type { SessionStore } from '../ports/session-store.js';

export { ANONYMIZED_EMAIL_DOMAIN, isAnonymizedEmail } from '../../domain/index.js';

export interface AccountAnonymizerDeps {
  readonly accounts: AccountAnonymizationUnitOfWork;
  /** Sessões do cookie da conta (`revokeAll`, spec 021). */
  readonly accountSessions: Pick<AccountSessionStore, 'revokeAll'>;
  /** Sessões Bearer dos vínculos (`revokeAllSessions`, spec 007/008). */
  readonly bearerSessions: Pick<SessionStore, 'revokeAllSessions'>;
  readonly mailer: AccountDeletionMailer;
  readonly logger: FastifyBaseLogger;
  readonly now?: () => Date;
}

export interface AnonymizeOptions {
  /** Evento da trilha da plataforma gravado NA transação (spec 045, E6); a exclusão pela pessoa (032) não tem. */
  readonly platformAudit?: NewPlatformAuditEvent;
  /**
   * Chamado logo depois do commit que anonimizou (antes da revogação final, que pode falhar com 503): o
   * chamador registra a ação (log, métrica) mesmo que a resposta seja 503 e a repetição devolva `false`.
   */
  readonly onCommitted?: () => void;
}

function accountNotFound(): NotFoundError {
  return new NotFoundError('Conta não encontrada', { context: { entity: 'Account' } });
}

type Outcome =
  | { readonly anonymized: false; readonly memberships: readonly AnonymizedMembershipRef[] }
  | { readonly anonymized: true; readonly memberships: readonly AnonymizedMembershipRef[] };

/**
 * Remove uma conta por **anonimização** (spec 032, E7), o núcleo único que o admin da plataforma usa (spec 045,
 * E6) e que a exclusão pela própria pessoa (032, E7) vai reaproveitar.
 *
 * 1. Pré-checagem (recusas e o e-mail lido ANTES): única dona ativa de empresa não removida = 409
 *    `COMPANY_OWNERSHIP`; período pago em vigor sem cancelamento = 409 `SUBSCRIPTION_ACTIVE`.
 * 2. `revokeAll` antes de mexer em qualquer coisa: Redis fora = 503 e nada alterado.
 * 3. Transação (empresas -> conta; já anonimizada por um pedido simultâneo = nada; as recusas de novo sob a
 *    trava): conta e vínculos anonimizados e a trilha.
 * 4. Depois do commit: `onCommitted`, `revokeAll` de novo e as sessões Bearer de cada vínculo (falha = 503
 *    com a conta já anonimizada; repetir refaz só a revogação), e o aviso "Conta excluída" ao endereço
 *    antigo, só se confirmado, em segundo plano (falha só no log).
 *
 * Já anonimizada: devolve `false`, refaz a revogação e não grava evento nem e-mail. Nunca loga e-mail.
 */
export class AccountAnonymizer {
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly deps: AccountAnonymizerDeps) {}

  async anonymize(accountId: AccountId, options: AnonymizeOptions = {}): Promise<boolean> {
    const now = this.now();
    const before = await this.deps.accounts.run(async (tx) => {
      const account = await tx.lockAccount(accountId);
      if (account === null) throw accountNotFound();
      if (isAnonymizedEmail(account.email)) {
        return { done: true as const, memberships: await tx.memberships(accountId) };
      }
      await this.refuse(tx, accountId, now);
      return { done: false as const, email: account.email, verified: account.verified };
    });
    if (before.done) {
      await this.revokeAfterCommit(accountId, before.memberships);
      return false;
    }

    // Sessões fora ANTES de alterar: Redis fora = 503 e nada muda.
    await this.deps.accountSessions.revokeAll(accountId);

    const anonymizedEmail = anonymizedEmailFor(randomUUID());
    const outcome = await this.deps.accounts.run(async (tx): Promise<Outcome> => {
      await tx.lockMemberCompanies(accountId);
      const account = await tx.lockAccount(accountId);
      if (account === null) throw accountNotFound();
      // Outro pedido anonimizou entre a pré-checagem e esta trava: repetição, sem evento nem e-mail.
      if (isAnonymizedEmail(account.email)) {
        return { anonymized: false, memberships: await tx.memberships(accountId) };
      }
      await this.refuse(tx, accountId, now);
      const memberships = await tx.anonymize(accountId, anonymizedEmail);
      if (options.platformAudit !== undefined) await tx.platformAudit(options.platformAudit);
      return { anonymized: true, memberships };
    });
    if (!outcome.anonymized) {
      await this.revokeAfterCommit(accountId, outcome.memberships);
      return false;
    }
    this.deps.logger.info(
      { accountId, memberships: outcome.memberships.length },
      'conta anonimizada',
    );
    options.onCommitted?.();
    if (before.verified) this.sendNotice(before.email, accountId);
    await this.revokeAfterCommit(accountId, outcome.memberships);
    return true;
  }

  /** Espera os avisos pendentes (desligamento); nunca rejeita. */
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

  private async refuse(
    tx: AccountAnonymizationTransaction,
    accountId: AccountId,
    now: Date,
  ): Promise<void> {
    if ((await tx.soleOwnerCompanies(accountId)) > 0) {
      throw new ConflictError('A conta é a única dona ativa de uma empresa', {
        code: 'COMPANY_OWNERSHIP',
      });
    }
    if (await tx.paidInForce(accountId, now)) {
      throw new ConflictError('Há um período pago em vigor sem cancelamento', {
        code: 'SUBSCRIPTION_ACTIVE',
      });
    }
  }

  private async revokeAfterCommit(
    accountId: AccountId,
    memberships: readonly AnonymizedMembershipRef[],
  ): Promise<void> {
    try {
      await this.deps.accountSessions.revokeAll(accountId);
      for (const { companyId, membershipId } of memberships) {
        await this.deps.bearerSessions.revokeAllSessions(companyId, membershipId);
      }
    } catch (error) {
      this.deps.logger.error(
        { accountId, reason: 'revocation_failed' },
        'conta anonimizada, mas a revogação das sessões falhou (repita o pedido)',
      );
      throw error;
    }
  }

  private sendNotice(email: string, accountId: AccountId): void {
    const task: Promise<void> = this.deps.mailer
      .sendAccountDeleted(email)
      .then(() => {
        this.deps.logger.info({ accountId, result: 'sent' }, 'aviso de conta excluída');
      })
      .catch(() => {
        this.deps.logger.warn({ accountId, result: 'failed' }, 'aviso de conta excluída não saiu');
      })
      .finally(() => {
        this.pending.delete(task);
      });
    this.pending.add(task);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}
