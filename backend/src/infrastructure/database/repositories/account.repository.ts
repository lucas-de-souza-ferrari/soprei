import { randomUUID } from 'node:crypto';
import {
  CompanyId,
  AccountId,
  MembershipId,
  type AccountRepository,
  type AccountMembership,
  type CompanyBillingPolicy,
  resolveAccess,
  type ResetFailureOutcome,
  type VerifyOutcome,
  RESET_DAILY_FAILURE_CAP,
  RESET_FAILURE_WINDOW_MS,
  RESET_MAX_ATTEMPTS,
  VERIFICATION_DAILY_FAILURE_CAP,
  VERIFICATION_FAILURE_WINDOW_MS,
  VERIFICATION_MAX_ATTEMPTS,
} from '../../../domain/index.js';
import type { TenantScopedPrisma } from '../extensions/tenant-scope.js';
import { runInTransaction } from '../transaction.js';
import { ensureTrialSubscription } from './billing.repository.js';
import { withRepositoryErrors } from './repository-errors.js';
import { ForbiddenError, ConflictError } from '../../../shared/errors/index.js';

/** Início da janela de 24 h do teto diário de erros de confirmação. */
function failureWindowStart(now: Date): Date {
  return new Date(now.getTime() - VERIFICATION_FAILURE_WINDOW_MS);
}

export class PrismaAccountRepository implements AccountRepository {
  constructor(private readonly db: TenantScopedPrisma) {}

  findByEmail(email: string) {
    return withRepositoryErrors('Account.findByEmail', async () => {
      const row = await this.db.account.findUnique({ where: { email } });
      return row === null ? null : { ...row, id: AccountId.parse(row.id) };
    });
  }
  findById(id: string) {
    return withRepositoryErrors('Account.findById', async () => {
      const row = await this.db.account.findUnique({ where: { id } });
      return row === null ? null : { ...row, id: AccountId.parse(row.id) };
    });
  }
  create(email: string, passwordHash: string) {
    return withRepositoryErrors('Account.create', async () => {
      const row = await this.db.account.create({ data: { email, passwordHash } });
      return { ...row, id: AccountId.parse(row.id) };
    });
  }
  registerUnverified(input: {
    id: string;
    email: string;
    passwordHash: string;
    verificationHash: string;
    expiresAt: Date;
    retryBefore: Date;
    now: Date;
  }): Promise<string | null> {
    return withRepositoryErrors('Account.register', async () => {
      const windowStart = failureWindowStart(input.now);
      // Um único INSERT ... ON CONFLICT: sem janela entre ler e gravar, e o mesmo custo de banco
      // para e-mail novo, não confirmado ou já confirmado. A substituição só ocorre na linha
      // ainda sem confirmação, depois do intervalo mínimo desde o último envio (o envio é
      // `verification_expires_at` menos a validade do código) e fora do teto diário de erros
      // (spec 020: janela aberta e 25 erros ou mais bloqueiam código novo).
      const rows = await this.db.$queryRaw<{ id: string }[]>`
        INSERT INTO accounts (id, email, password_hash, verification_hash, verification_expires_at)
        VALUES (${input.id}::uuid, ${input.email}, ${input.passwordHash}, ${input.verificationHash},
                ${input.expiresAt}::timestamptz)
        ON CONFLICT (email) DO UPDATE SET
          password_hash = EXCLUDED.password_hash,
          verification_hash = EXCLUDED.verification_hash,
          verification_expires_at = EXCLUDED.verification_expires_at,
          verification_attempts = 0,
          updated_at = CURRENT_TIMESTAMP
        WHERE accounts.email_verified_at IS NULL
          AND accounts.status = 'ACTIVE'
          AND (accounts.verification_expires_at IS NULL
               OR accounts.verification_expires_at <= ${input.retryBefore}::timestamptz)
          AND (accounts.verification_failures_since IS NULL
               OR accounts.verification_failures_since <= ${windowStart}::timestamptz
               OR accounts.verification_failures_day < ${VERIFICATION_DAILY_FAILURE_CAP}::int)
        RETURNING id`;
      return rows[0]?.id ?? null;
    });
  }
  async refreshVerification(
    id: string,
    hash: string,
    expiresAt: Date,
    retryBefore: Date,
    now: Date,
  ): Promise<boolean> {
    const windowStart = failureWindowStart(now);
    const rows = await withRepositoryErrors(
      'Account.refreshVerification',
      () =>
        this.db.$queryRaw<{ id: string }[]>`
        UPDATE accounts
        SET verification_hash = ${hash},
            verification_expires_at = ${expiresAt}::timestamptz,
            verification_attempts = 0,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${id}::uuid
          AND email_verified_at IS NULL
          AND status = 'ACTIVE'
          AND (verification_expires_at IS NULL
               OR verification_expires_at <= ${retryBefore}::timestamptz)
          AND (verification_failures_since IS NULL
               OR verification_failures_since <= ${windowStart}::timestamptz
               OR verification_failures_day < ${VERIFICATION_DAILY_FAILURE_CAP}::int)
        RETURNING id`,
    );
    return rows.length === 1;
  }
  async clearVerification(id: string, hash: string): Promise<void> {
    await withRepositoryErrors('Account.clearVerification', () =>
      this.db.account.updateMany({
        where: { id, verificationHash: hash, emailVerifiedAt: null },
        data: { verificationHash: null, verificationExpiresAt: null, verificationAttempts: 0 },
      }),
    );
  }
  async setVerification(id: string, hash: string, expiresAt: Date): Promise<void> {
    await withRepositoryErrors('Account.verification', () =>
      this.db.account.update({
        where: { id },
        data: { verificationHash: hash, verificationExpiresAt: expiresAt, verificationAttempts: 0 },
      }),
    );
  }
  async verify(id: string, hash: string, now: Date): Promise<VerifyOutcome> {
    return withRepositoryErrors('Account.verify', async () => {
      // 1. Sucesso: um UPDATE atômico que casa o hash vigente, o vencimento e o limite de erros.
      const confirmed = await this.db.$queryRaw<{ id: string }[]>`
        UPDATE accounts
        SET email_verified_at = ${now}::timestamptz,
            verification_hash = NULL,
            verification_expires_at = NULL,
            verification_attempts = 0,
            verification_failures_day = 0,
            verification_failures_since = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${id}::uuid
          AND verification_hash = ${hash}
          AND verification_expires_at > ${now}::timestamptz
          AND status = 'ACTIVE'
          AND email_verified_at IS NULL
          AND verification_attempts < ${VERIFICATION_MAX_ATTEMPTS}::int
        RETURNING id`;
      if (confirmed.length === 1) return 'verified';
      // 2. Falha: um segundo UPDATE atômico, só se há código vigente. O Postgres serializa os
      // UPDATEs da mesma linha; quem mata o código (5º erro da vez ou 25º do dia) apaga o hash
      // na mesma instrução, então nenhum UPDATE seguinte o casa nem incrementa. O vencimento
      // fica (o intervalo mínimo de reenvio continua contando desde o envio).
      const windowStart = failureWindowStart(now);
      const failed = await this.db.$queryRaw<{ dead: boolean }[]>`
        UPDATE accounts
        SET verification_attempts = verification_attempts + 1,
            verification_failures_day = CASE
              WHEN verification_failures_since IS NULL
                OR verification_failures_since <= ${windowStart}::timestamptz THEN 1
              ELSE verification_failures_day + 1 END,
            verification_failures_since = CASE
              WHEN verification_failures_since IS NULL
                OR verification_failures_since <= ${windowStart}::timestamptz
                THEN ${now}::timestamptz
              ELSE verification_failures_since END,
            verification_hash = CASE
              WHEN verification_attempts + 1 >= ${VERIFICATION_MAX_ATTEMPTS}::int
                OR (CASE
                      WHEN verification_failures_since IS NULL
                        OR verification_failures_since <= ${windowStart}::timestamptz THEN 1
                      ELSE verification_failures_day + 1 END)
                   >= ${VERIFICATION_DAILY_FAILURE_CAP}::int
              THEN NULL ELSE verification_hash END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${id}::uuid
          AND verification_hash IS NOT NULL
          AND verification_expires_at > ${now}::timestamptz
          AND email_verified_at IS NULL
          AND status = 'ACTIVE'
        RETURNING (verification_hash IS NULL) AS dead`;
      const row = failed[0];
      if (row === undefined) return 'unavailable';
      return row.dead ? 'exhausted' : 'wrong';
    });
  }
  async issueResetCode(
    email: string,
    hash: string,
    expiresAt: Date,
    retryBefore: Date,
    now: Date,
  ): Promise<string | null> {
    const windowStart = new Date(now.getTime() - RESET_FAILURE_WINDOW_MS);
    // Um único UPDATE casando por e-mail: o mesmo trabalho de banco para e-mail inexistente,
    // não confirmado, desativado ou barrado pelo intervalo e pelo teto diário (sem linha, não envia).
    const rows = await withRepositoryErrors(
      'Account.issueResetCode',
      () =>
        this.db.$queryRaw<{ id: string }[]>`
        UPDATE accounts
        SET reset_hash = ${hash},
            reset_expires_at = ${expiresAt}::timestamptz,
            reset_attempts = 0,
            updated_at = CURRENT_TIMESTAMP
        WHERE email = ${email}
          AND email_verified_at IS NOT NULL
          AND status = 'ACTIVE'
          AND (reset_expires_at IS NULL OR reset_expires_at <= ${retryBefore}::timestamptz)
          AND (reset_failures_since IS NULL
               OR reset_failures_since <= ${windowStart}::timestamptz
               OR reset_failures_day < ${RESET_DAILY_FAILURE_CAP}::int)
        RETURNING id`,
    );
    return rows[0]?.id ?? null;
  }
  async hasValidResetCode(email: string, hash: string, now: Date): Promise<boolean> {
    const rows = await withRepositoryErrors(
      'Account.hasValidResetCode',
      () =>
        this.db.$queryRaw<{ id: string }[]>`
        SELECT id FROM accounts
        WHERE email = ${email}
          AND reset_hash = ${hash}
          AND reset_expires_at > ${now}::timestamptz
          AND reset_attempts < ${RESET_MAX_ATTEMPTS}::int
          AND status = 'ACTIVE'
          AND email_verified_at IS NOT NULL`,
    );
    return rows.length === 1;
  }
  async recordResetFailure(email: string, now: Date): Promise<ResetFailureOutcome> {
    const windowStart = new Date(now.getTime() - RESET_FAILURE_WINDOW_MS);
    // O Postgres serializa os UPDATEs da mesma linha; quem mata o código (5º erro da vez ou 10º do
    // dia) apaga o hash na mesma instrução, então nenhum UPDATE seguinte o casa nem incrementa. O
    // vencimento fica: o intervalo mínimo entre pedidos continua contando desde o envio.
    const rows = await withRepositoryErrors(
      'Account.recordResetFailure',
      () =>
        this.db.$queryRaw<{ dead: boolean }[]>`
        UPDATE accounts
        SET reset_attempts = reset_attempts + 1,
            reset_failures_day = CASE
              WHEN reset_failures_since IS NULL
                OR reset_failures_since <= ${windowStart}::timestamptz THEN 1
              ELSE reset_failures_day + 1 END,
            reset_failures_since = CASE
              WHEN reset_failures_since IS NULL
                OR reset_failures_since <= ${windowStart}::timestamptz
                THEN ${now}::timestamptz
              ELSE reset_failures_since END,
            reset_hash = CASE
              WHEN reset_attempts + 1 >= ${RESET_MAX_ATTEMPTS}::int
                OR (CASE
                      WHEN reset_failures_since IS NULL
                        OR reset_failures_since <= ${windowStart}::timestamptz THEN 1
                      ELSE reset_failures_day + 1 END)
                   >= ${RESET_DAILY_FAILURE_CAP}::int
              THEN NULL ELSE reset_hash END,
            updated_at = CURRENT_TIMESTAMP
        WHERE email = ${email}
          AND reset_hash IS NOT NULL
          AND reset_expires_at > ${now}::timestamptz
          AND email_verified_at IS NOT NULL
          AND status = 'ACTIVE'
        RETURNING (reset_hash IS NULL) AS dead`,
    );
    const row = rows[0];
    if (row === undefined) return 'unavailable';
    return row.dead ? 'exhausted' : 'wrong';
  }
  async resetPassword(
    email: string,
    hash: string,
    passwordHash: string,
    now: Date,
  ): Promise<boolean> {
    // Troca de senha e morte do código são a mesma instrução: dois pedidos com o código certo, só
    // um casa o `reset_hash`; o outro encontra NULL.
    const rows = await withRepositoryErrors(
      'Account.resetPassword',
      () =>
        this.db.$queryRaw<{ id: string }[]>`
        UPDATE accounts
        SET password_hash = ${passwordHash},
            reset_hash = NULL,
            reset_expires_at = NULL,
            reset_attempts = 0,
            reset_failures_day = 0,
            reset_failures_since = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE email = ${email}
          AND reset_hash = ${hash}
          AND reset_expires_at > ${now}::timestamptz
          AND reset_attempts < ${RESET_MAX_ATTEMPTS}::int
          AND status = 'ACTIVE'
          AND email_verified_at IS NOT NULL
        RETURNING id`,
    );
    return rows.length === 1;
  }
  async clearResetCode(id: string, hash: string): Promise<void> {
    await withRepositoryErrors('Account.clearResetCode', () =>
      this.db.account.updateMany({
        where: { id, resetHash: hash },
        data: { resetHash: null, resetExpiresAt: null, resetAttempts: 0 },
      }),
    );
  }
  async listMemberships(accountId: string): Promise<readonly AccountMembership[]> {
    // Resolve apenas raízes de tenant acessíveis. Cada leitura do vínculo continua escopada.
    const companies = await withRepositoryErrors('Account.companies', () =>
      this.db.company.findMany({
        where: {
          deletedAt: null,
          status: 'ACTIVE',
          memberships: { some: { accountId, status: 'ACTIVE' } },
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: 100,
      }),
    );
    const result = await Promise.all(
      companies.map(({ id }) => this.membership(accountId, CompanyId.parse(id))),
    );
    return result.filter((row): row is AccountMembership => row !== null);
  }
  async membership(accountId: string, companyId: CompanyId): Promise<AccountMembership | null> {
    return withRepositoryErrors('Account.membership', async () => {
      const company = await this.db.company.findFirst({
        where: { id: companyId, deletedAt: null, status: 'ACTIVE' },
        select: { name: true },
      });
      if (company === null) return null;
      const membership = await this.db.membership.findFirst({
        where: { companyId, accountId, status: 'ACTIVE' },
        select: { id: true, role: true },
      });
      return membership === null
        ? null
        : {
            companyId,
            membershipId: MembershipId.parse(membership.id),
            name: company.name,
            role: membership.role,
          };
    });
  }
  async lastCompanyId(accountId: string): Promise<string | null> {
    const row = await withRepositoryErrors('Account.lastCompanyId', () =>
      this.db.account.findFirst({ where: { id: accountId }, select: { lastCompanyId: true } }),
    );
    return row?.lastCompanyId ?? null;
  }
  async setLastCompany(accountId: string, companyId: CompanyId): Promise<void> {
    await withRepositoryErrors('Account.setLastCompany', () =>
      this.db.account.updateMany({ where: { id: accountId }, data: { lastCompanyId: companyId } }),
    );
  }
  async createCompany(
    accountId: string,
    name: string,
    billing?: CompanyBillingPolicy,
  ): Promise<AccountMembership> {
    return withRepositoryErrors('Account.createCompany', () =>
      runInTransaction(this.db, async (tx) => {
        await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${accountId}::uuid FOR NO KEY UPDATE`;
        const account = await tx.account.findUnique({ where: { id: accountId } });
        if (account?.status !== 'ACTIVE' || account.emailVerifiedAt === null)
          throw new ForbiddenError('Conta indisponível');
        const count = await tx.company.count({ where: { memberships: { some: { accountId } } } });
        if (count >= 20) throw new ConflictError('Limite de 20 empresas por conta atingido');
        // Cobrança ligada (spec 031): na mesma transação que trava a conta, garante a assinatura (teste
        // gratuito na primeira vez), confere o acesso e o limite de empresas do plano e liga a empresa a ela.
        let subscriptionId: string | undefined;
        if (billing !== undefined) {
          const subscription = await ensureTrialSubscription(tx, accountId, billing.now, billing);
          const { access } = resolveAccess(subscription, billing.now, billing.graceDays);
          if (access === 'blocked') {
            throw new ForbiddenError('Assinatura inativa', { code: 'SUBSCRIPTION_INACTIVE' });
          }
          const owned = await tx.company.count({
            where: { subscriptionId: subscription.id, deletedAt: null },
          });
          if (owned >= subscription.plan.maxCompanies) {
            throw new ForbiddenError('Limite de empresas do plano atingido', {
              code: 'PLAN_COMPANY_LIMIT',
            });
          }
          subscriptionId = subscription.id;
        }
        const company = await tx.company.create({
          data: {
            name,
            slug: `empresa-${randomUUID()}`,
            ...(subscriptionId === undefined ? {} : { subscriptionId }),
          },
        });
        const companyId = CompanyId.parse(company.id);
        const membership = await tx.membership.create({
          data: {
            companyId,
            accountId,
            email: account.email,
            passwordHash: 'account-managed',
            role: 'OWNER',
          },
        });
        await tx.auditEvent.create({
          data: {
            companyId,
            actorMembershipId: membership.id,
            targetMembershipId: membership.id,
            action: 'MEMBERSHIP_CREATED',
            toRole: 'OWNER',
          },
        });
        return {
          companyId,
          membershipId: MembershipId.parse(membership.id),
          name: company.name,
          role: membership.role,
        };
      }),
    );
  }
}
