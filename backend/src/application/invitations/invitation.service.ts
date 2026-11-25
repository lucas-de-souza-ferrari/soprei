import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import {
  type AuditAction,
  type AccountRepository,
  COMPANY_SLUG_PATTERN,
  canManageRole,
  CompanyId,
  type CompanyInvitation,
  type CompanyInvitationRepository,
  type CompanyRepository,
  hasPermission,
  INVITATION_COMPANY_SENDS_PER_DAY,
  INVITATION_INVITER_SENDS_PER_DAY,
  INVITATION_MAX_PENDING,
  INVITATION_MAX_SENDS,
  INVITATION_QUOTA_WINDOW_MS,
  INVITATION_RESEND_INTERVAL_MS,
  INVITATION_VALIDITY_DAYS,
  INVITATION_VALIDITY_MS,
  type ListOptions,
  type MembershipRole,
  type Page,
  type Permission,
  type PlatformActionReason,
  type PlatformAuditAction,
} from '../../domain/index.js';
import type {
  InvitationEmailResult,
  InvitationMetricAction,
  InvitationMetricResult,
  Metrics,
} from '../../infrastructure/metrics/index.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from '../../shared/errors/index.js';
import { isUuid } from '../../shared/utils/index.js';
import { normalizeEmail } from '../auth/credentials.js';
import type { MembershipIdentity, PlatformIdentity } from '../auth/identity.js';
import { COMPANY_NAME_MAX_LENGTH } from '../companies/company.service.js';
import type { InvitationMailer } from '../ports/account-session.js';
import type { InvitationQuotaStore } from '../ports/invitation-quota.js';
import type {
  InvitationActor,
  InvitationTransaction,
  InvitationUnitOfWork,
} from '../ports/invitation-unit-of-work.js';
import type { PasswordHasher } from '../ports/password-hasher.js';
import {
  buildInvitationLink,
  buildInvitationToken,
  deriveInvitationKey,
  digestsMatch,
  generateInvitationSecret,
  invitationDigest,
  invitationQuotaDigest,
  parseInvitationToken,
  type ParsedInvitationToken,
} from './invitation-token.js';

/** Código e mensagem da falha uniforme de qualquer problema do convite (spec 025, decisão 10). */
export const INVITATION_INVALID_CODE = 'INVITATION_INVALID';
export const INVITATION_INVALID_MESSAGE = 'Convite inválido, vencido ou destinado a outro e-mail.';
export const INVITATION_LIMIT_CODE = 'INVITATION_LIMIT_REACHED';
const INVITATION_LIMIT_MESSAGE = 'Limite de convites atingido. Tente novamente mais tarde.';
/** `Retry-After` dos tetos que não têm um instante exato de liberação. */
const LIMIT_RETRY_SECONDS = 3600;
const SEND_ACTIONS: readonly AuditAction[] = ['INVITATION_CREATED', 'INVITATION_RESENT'];

/** O que a API devolve de um convite pendente: nunca o hash nem o segredo. */
export interface InvitationView {
  readonly id: string;
  readonly email: string;
  readonly role: MembershipRole;
  /** `PENDING` ou, passada a validade e ainda antes do expurgo, `EXPIRED`. */
  readonly state: 'PENDING' | 'EXPIRED';
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly lastSentAt: Date;
  readonly sendCount: number;
  /** Spec 045, E3b: convite feito pela plataforma (a empresa revoga, mas não reenvia). */
  readonly fromPlatform: boolean;
}

/**
 * Convite pendente como o admin da plataforma o vê (spec 045, E3b): o e-mail só **mascarado** (primeira
 * letra e domínio, o mesmo formato da E1); nunca o e-mail inteiro, o hash nem o segredo.
 */
export interface PlatformInvitationView {
  readonly id: string;
  readonly emailMasked: string;
  readonly role: MembershipRole;
  readonly state: 'PENDING' | 'EXPIRED';
  readonly invitedBy: 'membership' | 'platform';
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly lastSentAt: Date;
  readonly sendCount: number;
}

/** "Nova empresa" pelo admin (spec 045, E3b): a empresa e o convite de `OWNER`. */
export interface PlatformCreateCompanyInput {
  readonly name: string;
  readonly slug: string;
  readonly ownerEmail: string;
}

/** `l***@exemplo.com`: a mesma máscara das leituras do admin (spec 045, E1). */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return `${email.slice(0, 1)}***@${at < 0 ? '' : email.slice(at + 1)}`;
}

export interface InvitationPreview {
  readonly companyName: string;
  readonly role: MembershipRole;
  readonly email: string;
  readonly accountState: 'NEW' | 'EXISTS';
}

export interface CreateInvitationInput {
  /** Já validado; o service normaliza de novo por segurança. */
  readonly email: string;
  readonly role: MembershipRole;
}

export interface InvitationServiceDeps {
  /** Leituras fora de transação (lista e pré-checagem). As escritas passam pela `unitOfWork`. */
  readonly invitations: CompanyInvitationRepository;
  readonly companies: Pick<CompanyRepository, 'findById'>;
  /** Só a leitura do `preview` e a pré-checagem do aceite: o `create` nunca consulta contas. */
  readonly accounts: Pick<AccountRepository, 'findByEmail'>;
  readonly unitOfWork: InvitationUnitOfWork;
  readonly hasher: PasswordHasher;
  readonly mailer: InvitationMailer;
  readonly quota: InvitationQuotaStore;
  readonly logger: FastifyBaseLogger;
  readonly metrics?: Pick<
    Metrics,
    'countCompanyInvitation' | 'countCompanyInvitationEmail' | 'countPlatformAction'
  >;
  /** Chave derivada do `JWT_SECRET` (a mesma dos códigos da 020/021); o rótulo é próprio. */
  readonly loginSecret: string | Buffer;
  /** `APP_ORIGIN` exatamente como está (sem barra final). */
  readonly appOrigin: string;
  readonly now?: () => Date;
  readonly randomBytes?: (size: number) => Buffer;
}

/** Resultado de uma transação de aceite: ou o vínculo criado, ou o motivo (só para a métrica). */
type AcceptOutcome =
  | {
      readonly ok: true;
      readonly companyId: CompanyId;
      readonly membershipId: string;
      readonly invitationId: string;
      readonly role: MembershipRole;
    }
  | { readonly ok: false; readonly result: InvitationMetricResult };

interface Prechecked {
  readonly parsed: ParsedInvitationToken;
  readonly invitation: CompanyInvitation;
  readonly email: string;
  readonly digest: string;
}

function toView(invitation: CompanyInvitation, now: Date): InvitationView {
  return {
    id: invitation.id,
    email: invitation.email ?? '',
    role: invitation.role,
    state: invitation.expiresAt.getTime() <= now.getTime() ? 'EXPIRED' : 'PENDING',
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    lastSentAt: invitation.lastSentAt,
    sendCount: invitation.sendCount,
    fromPlatform: invitation.invitedByAdminId !== null,
  };
}

function toPlatformView(invitation: CompanyInvitation, now: Date): PlatformInvitationView {
  return {
    id: invitation.id,
    emailMasked: maskEmail(invitation.email ?? ''),
    role: invitation.role,
    state: invitation.expiresAt.getTime() <= now.getTime() ? 'EXPIRED' : 'PENDING',
    invitedBy: invitation.invitedByAdminId === null ? 'membership' : 'platform',
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    lastSentAt: invitation.lastSentAt,
    sendCount: invitation.sendCount,
  };
}

type PlatformActionMetric = Parameters<Metrics['countPlatformAction']>[0];

const PLATFORM_METRIC: Partial<Record<PlatformAuditAction, PlatformActionMetric>> = {
  COMPANY_CREATED: 'company_created',
  INVITATION_CREATED_BY_PLATFORM: 'invitation_created_by_platform',
  INVITATION_RESENT_BY_PLATFORM: 'invitation_resent_by_platform',
  INVITATION_REVOKED_BY_PLATFORM: 'invitation_revoked_by_platform',
};

function companyNotFound(): NotFoundError {
  return new NotFoundError('Empresa não encontrada', { context: { entity: 'Company' } });
}

function resultOf(error: unknown): InvitationMetricResult {
  if (error instanceof ForbiddenError) return 'forbidden';
  if (error instanceof RateLimitError) return 'limited';
  if (error instanceof ConflictError) return 'conflict';
  if (error instanceof NotFoundError) return 'invalid';
  return 'error';
}

/**
 * Convites por e-mail e aceite (spec 025). Não cria caminho de autorização novo: a permissão é
 * `membership:read`/`membership:manage` e a hierarquia, a de `canManageRole`; o papel e o estado do
 * ator são **relidos do banco dentro da transação**, com a linha da empresa travada.
 *
 * - **Segredo:** link de uso único com 256 bits; só o HMAC fica no banco. O token
 *   (`<companyId>.<invitationId>.<segredo>`) só acha a linha; quem autoriza é o HMAC.
 * - **Sem enumeração de contas:** o `create` nunca consulta `accounts`; a resposta não depende de a
 *   pessoa ter conta, de o e-mail ter sido enviado ou de a conta ter outras empresas.
 * - **Falha uniforme:** qualquer problema de um convite apresentado por token é a mesma 400
 *   `INVITATION_INVALID`; a razão vai só à métrica `company_invitations_total{action,result}`.
 * - **Privacidade:** e-mail, token, link e nome da empresa nunca vão a log, métrica, auditoria nem
 *   mensagem de erro; logam-se só ids e enums.
 */
export class InvitationService {
  private readonly key: Buffer;
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly deps: InvitationServiceDeps) {
    this.key = deriveInvitationKey(deps.loginSecret);
  }

  // --- leitura e gestão (autenticadas) ---

  async list(actor: MembershipIdentity, options?: ListOptions): Promise<Page<InvitationView>> {
    this.requirePermission(actor, 'membership:read');
    const page = await this.deps.invitations.listPending(actor.companyId, options);
    const now = this.now();
    return { items: page.items.map((item) => toView(item, now)), nextCursor: page.nextCursor };
  }

  create(actor: MembershipIdentity, input: CreateInvitationInput): Promise<InvitationView> {
    return this.track('create', async () => {
      // Cheque barato, pelo papel do token; a decisão final é a de dentro da transação.
      this.requirePermission(actor, 'membership:manage');
      if (input.role === 'OWNER') {
        throw new ValidationError('Papel não pode ser convidado', { code: 'ROLE_NOT_INVITABLE' });
      }
      this.requireHierarchy(actor, actor.role, input.role, 'create');
      const email = normalizeEmail(input.email);
      // Redis das cotas fora = 503 antes de gravar (fail-closed).
      await this.deps.quota.ping();
      const secret = generateInvitationSecret(this.deps.randomBytes);
      const tokenHash = invitationDigest(this.key, secret);

      const created = await this.deps.unitOfWork.run(async (tx) => {
        const company = await tx.lockCompany(actor.companyId);
        if (company.status !== 'ACTIVE') this.deny(actor, 'company_suspended', actor.role);
        const manager = await this.loadManager(tx, actor);
        this.requireHierarchy(actor, manager.role, input.role, 'create');
        if (await tx.hasMemberWithEmail(actor.companyId, email)) {
          throw new ConflictError('Já existe um membro com este e-mail', {
            code: 'MEMBER_ALREADY_EXISTS',
          });
        }
        const now = this.now();
        const existing = await tx.invitations.findPendingByEmail(actor.companyId, email);
        if (existing !== null) {
          if (existing.expiresAt.getTime() > now.getTime()) {
            throw new ConflictError('Já existe um convite pendente para este e-mail', {
              code: 'INVITATION_ALREADY_PENDING',
            });
          }
          // Pendente vencido: fecha (e-mail e hash anulados) e o novo convite entra no lugar.
          await tx.invitations.close(actor.companyId, existing.id, {
            status: 'EXPIRED',
            closedAt: now,
          });
        }
        await this.enforceQuotas(tx, actor, manager, now, true);
        const invitation = await tx.invitations.create(actor.companyId, {
          email,
          role: input.role,
          tokenHash,
          invitedByMembershipId: manager.id,
          expiresAt: new Date(now.getTime() + INVITATION_VALIDITY_MS),
          now,
        });
        await tx.audit.create(actor.companyId, {
          action: 'INVITATION_CREATED',
          actorMembershipId: manager.id,
          invitationId: invitation.id,
          toRole: invitation.role,
        });
        return { invitation, companyName: company.name, accountId: manager.accountId };
      });

      this.afterCommit(actor, 'INVITATION_CREATED', created.invitation.id, created.invitation.role);
      this.dispatch({
        invitation: created.invitation,
        companyName: created.companyName,
        secret,
        quotaOwner: created.accountId === null ? null : { kind: 'account', id: created.accountId },
      });
      return toView(created.invitation, this.now());
    });
  }

  resend(actor: MembershipIdentity, invitationId: string): Promise<InvitationView> {
    return this.track('resend', async () => {
      this.requirePermission(actor, 'membership:manage');
      await this.deps.quota.ping();
      const secret = generateInvitationSecret(this.deps.randomBytes);
      const tokenHash = invitationDigest(this.key, secret);

      const renewed = await this.deps.unitOfWork.run(async (tx) => {
        const company = await tx.lockCompany(actor.companyId);
        if (company.status !== 'ACTIVE') this.deny(actor, 'company_suspended', actor.role);
        const manager = await this.loadManager(tx, actor);
        const invitation = await tx.invitations.findById(actor.companyId, invitationId);
        // Spec 045, E3b (revisão, I1): o convite da plataforma (inclusive o de dono) só é reenviado pela
        // plataforma; a empresa pode revogá-lo, não prolongá-lo.
        if (invitation.invitedByAdminId !== null) {
          this.deps.logger.warn(
            { actorMembershipId: actor.membershipId, reason: 'platform_invitation' },
            'reenvio de convite da plataforma recusado',
          );
          throw new ForbiddenError('Convite feito pela equipe do Soprei', {
            code: 'INVITATION_FROM_PLATFORM',
          });
        }
        this.requireHierarchy(actor, manager.role, invitation.role, 'resend');
        if (invitation.status !== 'PENDING') throw this.notPending();
        const now = this.now();
        const wait =
          invitation.lastSentAt.getTime() + INVITATION_RESEND_INTERVAL_MS - now.getTime();
        if (wait > 0) throw this.limit(Math.ceil(wait / 1000));
        if (invitation.sendCount >= INVITATION_MAX_SENDS) throw this.limit(LIMIT_RETRY_SECONDS);
        await this.enforceQuotas(tx, actor, manager, now, false);
        const updated = await tx.invitations.renew(actor.companyId, invitation.id, {
          tokenHash,
          expiresAt: new Date(now.getTime() + INVITATION_VALIDITY_MS),
          lastSentAt: now,
        });
        if (updated === null) throw this.notPending();
        await tx.audit.create(actor.companyId, {
          action: 'INVITATION_RESENT',
          actorMembershipId: manager.id,
          invitationId: updated.id,
          toRole: updated.role,
        });
        return { invitation: updated, companyName: company.name, accountId: manager.accountId };
      });

      this.afterCommit(actor, 'INVITATION_RESENT', renewed.invitation.id, renewed.invitation.role);
      this.dispatch({
        invitation: renewed.invitation,
        companyName: renewed.companyName,
        secret,
        quotaOwner: renewed.accountId === null ? null : { kind: 'account', id: renewed.accountId },
      });
      return toView(renewed.invitation, this.now());
    });
  }

  revoke(actor: MembershipIdentity, invitationId: string): Promise<void> {
    return this.track('revoke', async () => {
      this.requirePermission(actor, 'membership:manage');
      const outcome = await this.deps.unitOfWork.run(async (tx) => {
        await tx.lockCompany(actor.companyId);
        const manager = await this.loadManager(tx, actor);
        const invitation = await tx.invitations.findById(actor.companyId, invitationId);
        this.requireHierarchy(actor, manager.role, invitation.role, 'revoke');
        // Idempotente: revogar o que já está revogado é 204; aceito ou expirado não é revogável.
        if (invitation.status === 'REVOKED') return 'already' as const;
        if (invitation.status !== 'PENDING') throw this.notPending();
        const closed = await tx.invitations.close(actor.companyId, invitation.id, {
          status: 'REVOKED',
          closedAt: this.now(),
        });
        if (!closed) throw this.notPending();
        await tx.audit.create(actor.companyId, {
          action: 'INVITATION_REVOKED',
          actorMembershipId: manager.id,
          invitationId: invitation.id,
          toRole: invitation.role,
        });
        return { invitationId: invitation.id, role: invitation.role };
      });
      if (outcome !== 'already') {
        this.afterCommit(actor, 'INVITATION_REVOKED', outcome.invitationId, outcome.role);
      }
    });
  }

  // --- admin da plataforma (spec 045, E3b) ---

  /**
   * Convites pendentes de uma empresa para o admin (e-mail mascarado). Empresa inexistente ou removida: 404.
   */
  async listForCompany(
    companyId: string,
    options?: ListOptions,
  ): Promise<Page<PlatformInvitationView>> {
    const id = this.platformCompanyId(companyId);
    try {
      await this.deps.companies.findById(id);
    } catch (error) {
      if (error instanceof NotFoundError) throw companyNotFound();
      throw error;
    }
    const page = await this.deps.invitations.listPending(id, options);
    const now = this.now();
    return {
      items: page.items.map((item) => toPlatformView(item, now)),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * O admin convida qualquer papel, inclusive `OWNER` (D8): mesmas regras da 025 (membro existente,
   * pendente repetido, 20 pendentes e 30 envios por empresa contados sob a trava, 3 e-mails por
   * destinatário por dia no Redis), com a cota do convidador trocada por 50 por admin por dia. Não consulta
   * contas. Trilha `INVITATION_CREATED_BY_PLATFORM` na transação (a da empresa não é tocada, D9).
   */
  createByPlatform(
    identity: PlatformIdentity,
    companyId: string,
    input: CreateInvitationInput,
    reason: PlatformActionReason,
  ): Promise<PlatformInvitationView> {
    return this.track('create', async () => {
      const id = this.platformCompanyId(companyId);
      const email = normalizeEmail(input.email);
      await this.deps.quota.ping();
      const secret = generateInvitationSecret(this.deps.randomBytes);
      const tokenHash = invitationDigest(this.key, secret);
      const created = await this.deps.unitOfWork.run(async (tx) => {
        const company = await tx.lockCompany(id);
        if (company.status !== 'ACTIVE') throw this.companyInactive();
        const invitation = await this.platformInvite(
          tx,
          identity,
          id,
          email,
          input.role,
          tokenHash,
        );
        await tx.platformAudit({
          adminId: identity.adminId,
          action: 'INVITATION_CREATED_BY_PLATFORM',
          subjectCompanyId: id,
          subjectInvitationId: invitation.id,
          toRole: invitation.role,
          reason,
        });
        return { invitation, companyName: company.name };
      });
      this.platformRecorded(
        identity,
        id,
        'INVITATION_CREATED_BY_PLATFORM',
        reason,
        created.invitation.id,
      );
      this.dispatch({
        invitation: created.invitation,
        companyName: created.companyName,
        secret,
        quotaOwner: { kind: 'admin', id: identity.adminId },
      });
      return toPlatformView(created.invitation, this.now());
    });
  }

  /**
   * "Nova empresa" (D4): cria a empresa `ACTIVE` e, na MESMA transação, o convite de `OWNER` para
   * `ownerEmail`. Slug repetido (inclusive de removida) = 409 `SLUG_TAKEN`; falha no convite = nenhuma
   * empresa. Trilha `COMPANY_CREATED` e `INVITATION_CREATED_BY_PLATFORM`.
   */
  createCompanyWithOwner(
    identity: PlatformIdentity,
    input: PlatformCreateCompanyInput,
    reason: PlatformActionReason,
  ): Promise<{ readonly companyId: CompanyId; readonly invitation: PlatformInvitationView }> {
    return this.track('create', async () => {
      const name = input.name.trim();
      if (name.length === 0 || name.length > COMPANY_NAME_MAX_LENGTH) {
        throw new ValidationError(
          `name deve ter de 1 a ${String(COMPANY_NAME_MAX_LENGTH)} caracteres`,
        );
      }
      if (!COMPANY_SLUG_PATTERN.test(input.slug)) {
        throw new ValidationError(
          'slug deve ter de 3 a 63 caracteres: letras minúsculas, dígitos e hífen',
        );
      }
      const email = normalizeEmail(input.ownerEmail);
      await this.deps.quota.ping();
      const secret = generateInvitationSecret(this.deps.randomBytes);
      const tokenHash = invitationDigest(this.key, secret);
      const created = await this.deps.unitOfWork.run(async (tx) => {
        const companyId = await tx.createCompany({ name, slug: input.slug });
        const company = await tx.lockCompany(companyId);
        await tx.platformAudit({
          adminId: identity.adminId,
          action: 'COMPANY_CREATED',
          subjectCompanyId: companyId,
          reason,
        });
        const invitation = await this.platformInvite(
          tx,
          identity,
          companyId,
          email,
          'OWNER',
          tokenHash,
        );
        await tx.platformAudit({
          adminId: identity.adminId,
          action: 'INVITATION_CREATED_BY_PLATFORM',
          subjectCompanyId: companyId,
          subjectInvitationId: invitation.id,
          toRole: 'OWNER',
          reason,
        });
        return { companyId, invitation, companyName: company.name };
      });
      this.platformRecorded(identity, created.companyId, 'COMPANY_CREATED', reason);
      this.platformRecorded(
        identity,
        created.companyId,
        'INVITATION_CREATED_BY_PLATFORM',
        reason,
        created.invitation.id,
      );
      this.dispatch({
        invitation: created.invitation,
        companyName: created.companyName,
        secret,
        quotaOwner: { kind: 'admin', id: identity.adminId },
      });
      return {
        companyId: created.companyId,
        invitation: toPlatformView(created.invitation, this.now()),
      };
    });
  }

  /** Reenvia qualquer convite pendente da empresa (60 s entre envios, até 6): trilha `..._RESENT_BY_PLATFORM`. */
  resendByPlatform(
    identity: PlatformIdentity,
    companyId: string,
    invitationId: string,
    reason: PlatformActionReason,
  ): Promise<PlatformInvitationView> {
    return this.track('resend', async () => {
      const id = this.platformCompanyId(companyId);
      await this.deps.quota.ping();
      const secret = generateInvitationSecret(this.deps.randomBytes);
      const tokenHash = invitationDigest(this.key, secret);
      const renewed = await this.deps.unitOfWork.run(async (tx) => {
        const company = await tx.lockCompany(id);
        if (company.status !== 'ACTIVE') throw this.companyInactive();
        const invitation = await tx.invitations.findById(id, invitationId);
        if (invitation.status !== 'PENDING') throw this.notPending();
        const now = this.now();
        const wait =
          invitation.lastSentAt.getTime() + INVITATION_RESEND_INTERVAL_MS - now.getTime();
        if (wait > 0) throw this.limit(Math.ceil(wait / 1000));
        if (invitation.sendCount >= INVITATION_MAX_SENDS) throw this.limit(LIMIT_RETRY_SECONDS);
        await this.enforceCompanySends(tx, id, now);
        const updated = await tx.invitations.renew(id, invitation.id, {
          tokenHash,
          expiresAt: new Date(now.getTime() + INVITATION_VALIDITY_MS),
          lastSentAt: now,
        });
        if (updated === null) throw this.notPending();
        await tx.platformAudit({
          adminId: identity.adminId,
          action: 'INVITATION_RESENT_BY_PLATFORM',
          subjectCompanyId: id,
          subjectInvitationId: updated.id,
          toRole: updated.role,
          reason,
        });
        return { invitation: updated, companyName: company.name };
      });
      this.platformRecorded(
        identity,
        id,
        'INVITATION_RESENT_BY_PLATFORM',
        reason,
        renewed.invitation.id,
      );
      this.dispatch({
        invitation: renewed.invitation,
        companyName: renewed.companyName,
        secret,
        quotaOwner: { kind: 'admin', id: identity.adminId },
      });
      return toPlatformView(renewed.invitation, this.now());
    });
  }

  /** Revoga qualquer convite pendente da empresa; já revogado = 204 sem evento; aceito ou vencido = 409. */
  revokeByPlatform(
    identity: PlatformIdentity,
    companyId: string,
    invitationId: string,
    reason: PlatformActionReason,
  ): Promise<void> {
    return this.track('revoke', async () => {
      const id = this.platformCompanyId(companyId);
      const outcome = await this.deps.unitOfWork.run(async (tx) => {
        await tx.lockCompany(id);
        const invitation = await tx.invitations.findById(id, invitationId);
        if (invitation.status === 'REVOKED') return null;
        if (invitation.status !== 'PENDING') throw this.notPending();
        const closed = await tx.invitations.close(id, invitation.id, {
          status: 'REVOKED',
          closedAt: this.now(),
        });
        if (!closed) throw this.notPending();
        await tx.platformAudit({
          adminId: identity.adminId,
          action: 'INVITATION_REVOKED_BY_PLATFORM',
          subjectCompanyId: id,
          subjectInvitationId: invitation.id,
          toRole: invitation.role,
          reason,
        });
        return invitation.id;
      });
      if (outcome !== null) {
        this.platformRecorded(identity, id, 'INVITATION_REVOKED_BY_PLATFORM', reason, outcome);
      }
    });
  }

  /** O convite da plataforma sob a trava da empresa (a parte comum de convidar e de criar empresa). */
  private async platformInvite(
    tx: InvitationTransaction,
    identity: PlatformIdentity,
    companyId: CompanyId,
    email: string,
    role: MembershipRole,
    tokenHash: string,
  ): Promise<CompanyInvitation> {
    if (await tx.hasMemberWithEmail(companyId, email)) {
      throw new ConflictError('Já existe um membro com este e-mail', {
        code: 'MEMBER_ALREADY_EXISTS',
      });
    }
    const now = this.now();
    const existing = await tx.invitations.findPendingByEmail(companyId, email);
    if (existing !== null) {
      if (existing.expiresAt.getTime() > now.getTime()) {
        throw new ConflictError('Já existe um convite pendente para este e-mail', {
          code: 'INVITATION_ALREADY_PENDING',
        });
      }
      await tx.invitations.close(companyId, existing.id, { status: 'EXPIRED', closedAt: now });
    }
    if ((await tx.invitations.countPending(companyId, now)) >= INVITATION_MAX_PENDING) {
      throw this.limit(LIMIT_RETRY_SECONDS);
    }
    await this.enforceCompanySends(tx, companyId, now);
    return tx.invitations.create(companyId, {
      email,
      role,
      tokenHash,
      invitedByAdminId: identity.adminId,
      expiresAt: new Date(now.getTime() + INVITATION_VALIDITY_MS),
      now,
    });
  }

  /** 30 envios por empresa em 24 h (os da empresa e os da plataforma), contados sob a trava. */
  private async enforceCompanySends(
    tx: InvitationTransaction,
    companyId: CompanyId,
    now: Date,
  ): Promise<void> {
    const since = new Date(now.getTime() - INVITATION_QUOTA_WINDOW_MS);
    const sent =
      (await tx.audit.countSince(companyId, { actions: SEND_ACTIONS, since })) +
      (await tx.countPlatformSends(companyId, since));
    if (sent >= INVITATION_COMPANY_SENDS_PER_DAY) throw this.limit(LIMIT_RETRY_SECONDS);
  }

  private platformCompanyId(companyId: string): CompanyId {
    if (!isUuid(companyId)) throw companyNotFound();
    return CompanyId.parse(companyId);
  }

  private companyInactive(): ConflictError {
    return new ConflictError('A empresa está suspensa', { code: 'COMPANY_INACTIVE' });
  }

  /** Métrica da plataforma e log só com ids, ação e motivo (nunca e-mail, nome, token ou link). */
  private platformRecorded(
    identity: PlatformIdentity,
    companyId: CompanyId,
    action: PlatformAuditAction,
    reason: PlatformActionReason,
    invitationId?: string,
  ): void {
    const metric = PLATFORM_METRIC[action];
    try {
      if (metric !== undefined) this.deps.metrics?.countPlatformAction(metric);
    } catch (error) {
      this.deps.logger.warn({ err: error }, 'falha ao registrar métrica da plataforma');
    }
    this.deps.logger.info(
      { adminId: identity.adminId, companyId, invitationId: invitationId ?? null, action, reason },
      'admin da plataforma agiu sobre convites',
    );
  }

  // --- rotas públicas (token) ---

  /** Mostra o convite sem consumir nada. Toda falha é a mesma 400. */
  async preview(token: string): Promise<InvitationPreview> {
    const checked = await this.precheck(token, 'preview');
    const company = await this.companyOf(checked.parsed.companyId, 'preview');
    const account = await this.deps.accounts.findByEmail(checked.email);
    if (account?.status === 'DISABLED') throw this.fail('preview', 'invalid');
    this.count('preview', 'ok');
    return {
      companyName: company.name,
      role: checked.invitation.role,
      email: checked.email,
      // Conta não confirmada conta como NEW: é o que leva ao `accept-new`.
      accountState: account !== null && account.emailVerifiedAt !== null ? 'EXISTS' : 'NEW',
    };
  }

  /**
   * Aceite por quem está logado (casos a e b): o e-mail da conta precisa ser o do convite. Devolve a
   * empresa para o chamador selecioná-la na sessão (a seleção é do `AccountService`).
   */
  async accept(
    account: { readonly id: string; readonly email: string },
    token: string,
  ): Promise<{ readonly companyId: CompanyId }> {
    const checked = await this.precheck(token, 'accept');
    if (normalizeEmail(account.email) !== checked.email) throw this.fail('accept', 'mismatch');
    const outcome = await this.deps.unitOfWork.run(async (tx): Promise<AcceptOutcome> =>
      this.acceptInTransaction(tx, checked, account.id),
    );
    return this.settle('accept', outcome);
  }

  /**
   * Aceite sem conta ou com conta não confirmada (caso c): o link prova a posse do e-mail, então cria
   * (ou confirma, **substituindo a senha**) a conta e o vínculo, sem login automático. O hash da
   * senha só é pago depois da pré-checagem.
   */
  async acceptNew(token: string, password: string): Promise<void> {
    const checked = await this.precheck(token, 'accept_new');
    // Conta confirmada ou desativada não segue por aqui: não paga hash à toa (a transação reconfere).
    const existing = await this.deps.accounts.findByEmail(checked.email);
    if (existing !== null && (existing.emailVerifiedAt !== null || existing.status !== 'ACTIVE')) {
      throw this.fail('accept_new', 'invalid');
    }
    const passwordHash = await this.deps.hasher.hash(password);
    const outcome = await this.deps.unitOfWork.run(async (tx): Promise<AcceptOutcome> =>
      this.acceptNewInTransaction(tx, checked, passwordHash),
    );
    this.settle('accept_new', outcome);
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

  // --- aceite ---

  private async acceptInTransaction(
    tx: InvitationTransaction,
    checked: Prechecked,
    accountId: string,
  ): Promise<AcceptOutcome> {
    const now = this.now();
    const { companyId, invitation } = await this.gate(tx, checked, now);
    if (invitation === null) return { ok: false, result: 'invalid' };
    // Ordem fixa: empresa (feito no gate), depois a linha da conta.
    const account = await tx.lockAccountById(accountId);
    if (account === null || account.email !== checked.email) {
      return { ok: false, result: 'mismatch' };
    }
    if (account.status !== 'ACTIVE' || account.emailVerifiedAt === null) {
      return { ok: false, result: 'invalid' };
    }
    const blocked = await this.checkInviter(tx, companyId, invitation, now);
    if (blocked !== null) return blocked;
    return this.createMembershipAndClose(tx, companyId, invitation, account.id, checked.email, now);
  }

  private async acceptNewInTransaction(
    tx: InvitationTransaction,
    checked: Prechecked,
    passwordHash: string,
  ): Promise<AcceptOutcome> {
    const now = this.now();
    const { companyId, invitation } = await this.gate(tx, checked, now);
    if (invitation === null) return { ok: false, result: 'invalid' };
    const blocked = await this.checkInviter(tx, companyId, invitation, now);
    if (blocked !== null) return blocked;
    let accountId: string;
    const existing = await tx.lockAccountByEmail(checked.email);
    if (existing === null) {
      accountId = randomUUID();
      const created = await tx.createConfirmedAccount({
        id: accountId,
        email: checked.email,
        passwordHash,
        now,
      });
      // Outra transação criou a conta no meio: o e-mail agora existe, quem vê é o preview.
      if (!created) return { ok: false, result: 'invalid' };
    } else if (existing.status === 'ACTIVE' && existing.emailVerifiedAt === null) {
      // Pré-cadastro (possivelmente hostil) do e-mail: quem prova a posse do caixa define a senha.
      if (!(await tx.confirmUnverifiedAccount(existing.id, passwordHash, now))) {
        return { ok: false, result: 'invalid' };
      }
      accountId = existing.id;
    } else {
      return { ok: false, result: 'invalid' };
    }
    return this.createMembershipAndClose(tx, companyId, invitation, accountId, checked.email, now);
  }

  /**
   * Relê tudo **sob o bloqueio da empresa**: empresa ativa, convite ainda pendente, não vencido e com
   * o mesmo segredo (um reenvio no meio troca o hash). Qualquer falha é "invalid" e nada é escrito.
   */
  private async gate(
    tx: InvitationTransaction,
    checked: Prechecked,
    now: Date,
  ): Promise<{ companyId: CompanyId; invitation: CompanyInvitation | null }> {
    const companyId = CompanyId.parse(checked.parsed.companyId);
    let status: string;
    try {
      status = (await tx.lockCompany(companyId)).status;
    } catch (error) {
      if (error instanceof NotFoundError) return { companyId, invitation: null };
      throw error;
    }
    if (status !== 'ACTIVE') return { companyId, invitation: null };
    let invitation: CompanyInvitation;
    try {
      invitation = await tx.invitations.findById(companyId, checked.parsed.invitationId);
    } catch (error) {
      if (error instanceof NotFoundError) return { companyId, invitation: null };
      throw error;
    }
    if (
      invitation.status !== 'PENDING' ||
      invitation.email === null ||
      invitation.tokenHash === null ||
      invitation.expiresAt.getTime() <= now.getTime() ||
      !digestsMatch(invitation.tokenHash, checked.digest)
    ) {
      return { companyId, invitation: null };
    }
    return { companyId, invitation };
  }

  /**
   * Quem convidou precisa continuar ativo, com `membership:manage` e hierarquia sobre o papel do
   * convite (decisão 13). Senão o convite é fechado como `REVOKED` e o aceite recebe a falha uniforme.
   */
  private async checkInviter(
    tx: InvitationTransaction,
    companyId: CompanyId,
    invitation: CompanyInvitation,
    now: Date,
  ): Promise<AcceptOutcome | null> {
    // Spec 045, E3b: convite da plataforma vale enquanto o admin que convidou estiver ativo.
    if (invitation.invitedByAdminId !== null) {
      if ((await tx.adminStatus(invitation.invitedByAdminId)) === 'ACTIVE') return null;
    } else if (invitation.invitedByMembershipId !== null) {
      const inviter = await tx.actor(companyId, invitation.invitedByMembershipId);
      if (
        inviter !== null &&
        inviter.status === 'ACTIVE' &&
        hasPermission(inviter.role, 'membership:manage') &&
        canManageRole(inviter.role, invitation.role)
      ) {
        return null;
      }
    }
    await tx.invitations.close(companyId, invitation.id, { status: 'REVOKED', closedAt: now });
    return { ok: false, result: 'forbidden' };
  }

  private async createMembershipAndClose(
    tx: InvitationTransaction,
    companyId: CompanyId,
    invitation: CompanyInvitation,
    accountId: string,
    email: string,
    now: Date,
  ): Promise<AcceptOutcome> {
    // Não rebaixa nem reativa por convite: conta que já tem vínculo (ou e-mail de membro) fecha o convite.
    if (
      (await tx.hasMembershipForAccount(companyId, accountId)) ||
      (await tx.hasMemberWithEmail(companyId, email))
    ) {
      await tx.invitations.close(companyId, invitation.id, { status: 'REVOKED', closedAt: now });
      return { ok: false, result: 'conflict' };
    }
    const membership = await tx.createMembership(companyId, {
      accountId,
      email,
      role: invitation.role,
    });
    const closed = await tx.invitations.close(companyId, invitation.id, {
      status: 'ACCEPTED',
      closedAt: now,
      acceptedMembershipId: membership.id,
    });
    if (!closed) return { ok: false, result: 'invalid' };
    await tx.audit.create(companyId, {
      action: 'INVITATION_ACCEPTED',
      actorMembershipId: membership.id,
      targetMembershipId: membership.id,
      invitationId: invitation.id,
      toRole: invitation.role,
    });
    return {
      ok: true,
      companyId,
      membershipId: membership.id,
      invitationId: invitation.id,
      role: invitation.role,
    };
  }

  private settle(
    action: 'accept' | 'accept_new',
    outcome: AcceptOutcome,
  ): { readonly companyId: CompanyId } {
    if (!outcome.ok) throw this.fail(action, outcome.result);
    // Depois do commit: nada é logado de transação desfeita.
    this.afterCommitLog('INVITATION_ACCEPTED', {
      companyId: outcome.companyId,
      actorMembershipId: outcome.membershipId,
      targetMembershipId: outcome.membershipId,
      invitationId: outcome.invitationId,
      toRole: outcome.role,
    });
    this.count(action, 'ok');
    return { companyId: outcome.companyId };
  }

  // --- pré-checagem (sem consumir, antes de qualquer hash caro) ---

  private async precheck(
    token: string,
    action: 'preview' | 'accept' | 'accept_new',
  ): Promise<Prechecked> {
    const parsed = parseInvitationToken(token);
    if (parsed === null) throw this.fail(action, 'invalid');
    let invitation: CompanyInvitation;
    try {
      invitation = await this.deps.invitations.findById(
        CompanyId.parse(parsed.companyId),
        parsed.invitationId,
      );
    } catch (error) {
      if (error instanceof NotFoundError) throw this.fail(action, 'invalid');
      throw error;
    }
    const digest = invitationDigest(this.key, parsed.secret);
    if (
      invitation.status !== 'PENDING' ||
      invitation.email === null ||
      invitation.tokenHash === null ||
      invitation.expiresAt.getTime() <= this.now().getTime() ||
      !digestsMatch(invitation.tokenHash, digest)
    ) {
      throw this.fail(action, 'invalid');
    }
    return { parsed, invitation, email: invitation.email, digest };
  }

  private async companyOf(companyId: string, action: 'preview') {
    try {
      const company = await this.deps.companies.findById(CompanyId.parse(companyId));
      if (company.status !== 'ACTIVE') throw this.fail(action, 'invalid');
      return company;
    } catch (error) {
      if (error instanceof NotFoundError) throw this.fail(action, 'invalid');
      throw error;
    }
  }

  // --- regras ---

  private requirePermission(actor: MembershipIdentity, permission: Permission): void {
    if (hasPermission(actor.role, permission)) return;
    this.deny(actor, 'permission', actor.role);
  }

  private requireHierarchy(
    actor: MembershipIdentity,
    actorRole: MembershipRole,
    subjectRole: MembershipRole,
    operation: string,
  ): void {
    if (!canManageRole(actorRole, subjectRole))
      this.deny(actor, `hierarchy_${operation}`, actorRole);
  }

  /** O ator relido do banco: ativo e com `membership:manage`. Ausente, desativado ou sem permissão = 403. */
  private async loadManager(
    tx: InvitationTransaction,
    actor: MembershipIdentity,
  ): Promise<InvitationActor> {
    const current = await tx.actor(actor.companyId, actor.membershipId);
    if (current === null) return this.deny(actor, 'actor_missing', actor.role);
    if (current.status !== 'ACTIVE' || !hasPermission(current.role, 'membership:manage')) {
      return this.deny(actor, 'actor_not_allowed', current.role);
    }
    return current;
  }

  /** Tetos por empresa e por convidador, contados **sob o bloqueio da empresa** (exatos sob concorrência). */
  private async enforceQuotas(
    tx: InvitationTransaction,
    actor: MembershipIdentity,
    manager: InvitationActor,
    now: Date,
    countPending: boolean,
  ): Promise<void> {
    if (countPending) {
      if ((await tx.invitations.countPending(actor.companyId, now)) >= INVITATION_MAX_PENDING) {
        throw this.limit(LIMIT_RETRY_SECONDS);
      }
    }
    const since = new Date(now.getTime() - INVITATION_QUOTA_WINDOW_MS);
    const sentByCompany =
      (await tx.audit.countSince(actor.companyId, { actions: SEND_ACTIONS, since })) +
      (await tx.countPlatformSends(actor.companyId, since));
    if (sentByCompany >= INVITATION_COMPANY_SENDS_PER_DAY) throw this.limit(LIMIT_RETRY_SECONDS);
    const sentByInviter = await tx.audit.countSince(actor.companyId, {
      actions: SEND_ACTIONS,
      since,
      actorMembershipId: manager.id,
    });
    if (sentByInviter >= INVITATION_INVITER_SENDS_PER_DAY) throw this.limit(LIMIT_RETRY_SECONDS);
  }

  private limit(retryAfterSeconds: number): RateLimitError {
    return new RateLimitError(retryAfterSeconds, INVITATION_LIMIT_MESSAGE, {
      code: INVITATION_LIMIT_CODE,
    });
  }

  private notPending(): ConflictError {
    return new ConflictError('O convite não está mais pendente', {
      code: 'INVITATION_NOT_PENDING',
    });
  }

  private deny(actor: MembershipIdentity, reason: string, role: MembershipRole): never {
    this.deps.logger.warn(
      { actorMembershipId: actor.membershipId, role, reason },
      'operação de convite negada pela permissão ou hierarquia',
    );
    throw new ForbiddenError();
  }

  /** A falha uniforme: a razão vai só à métrica (rótulo fixo) e ao log (resultado, sem dado algum). */
  private fail(
    action: 'preview' | 'accept' | 'accept_new',
    result: InvitationMetricResult,
  ): ValidationError {
    this.count(action, result);
    this.deps.logger.info({ action, result }, 'convite recusado');
    return new ValidationError(INVITATION_INVALID_MESSAGE, { code: INVITATION_INVALID_CODE });
  }

  // --- efeitos ---

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async track<T>(action: InvitationMetricAction, work: () => Promise<T>): Promise<T> {
    try {
      const value = await work();
      this.count(action, 'ok');
      return value;
    } catch (error) {
      this.count(action, resultOf(error));
      throw error;
    }
  }

  private count(action: InvitationMetricAction, result: InvitationMetricResult): void {
    try {
      this.deps.metrics?.countCompanyInvitation(action, result);
    } catch (error) {
      this.deps.logger.warn({ err: error }, 'falha ao registrar métrica de convite');
    }
  }

  private countEmail(result: InvitationEmailResult): void {
    try {
      this.deps.metrics?.countCompanyInvitationEmail(result);
    } catch (error) {
      this.deps.logger.warn({ err: error }, 'falha ao registrar métrica de e-mail de convite');
    }
  }

  private afterCommit(
    actor: MembershipIdentity,
    action: AuditAction,
    invitationId: string,
    toRole: MembershipRole,
  ): void {
    this.afterCommitLog(action, {
      companyId: actor.companyId,
      actorMembershipId: actor.membershipId,
      invitationId,
      toRole,
    });
  }

  /** Log `audit` só com ids e enum: nunca e-mail, token, link nem nome da empresa. */
  private afterCommitLog(
    action: AuditAction,
    fields: {
      readonly companyId: string;
      readonly actorMembershipId: string;
      readonly invitationId: string;
      readonly toRole: MembershipRole;
      readonly targetMembershipId?: string;
    },
  ): void {
    this.deps.logger.info(
      {
        event: 'audit',
        action,
        companyId: fields.companyId,
        actorMembershipId: fields.actorMembershipId,
        invitationId: fields.invitationId,
        targetMembershipId: fields.targetMembershipId ?? null,
        toRole: fields.toRole,
      },
      'audit',
    );
  }

  /**
   * Envio em segundo plano, **depois** do commit: nem o tempo nem uma falha de SMTP aparecem na
   * resposta. As cotas entre empresas (destinatário e conta convidadora) estouram **em silêncio**: o
   * convite fica gravado e a resposta é a mesma, sem envio. O resultado vai só à métrica e ao log.
   */
  private dispatch(input: {
    readonly invitation: CompanyInvitation;
    readonly companyName: string;
    readonly secret: string;
    /** Dono da cota de 50 envios por dia (Redis): a conta convidadora (025) ou o admin (045, E3b). */
    readonly quotaOwner: { readonly kind: 'account' | 'admin'; readonly id: string } | null;
  }): void {
    const { invitation } = input;
    const email = invitation.email;
    if (email === null) return;
    const task: Promise<void> = (async () => {
      let result: InvitationEmailResult;
      try {
        const allowed = await this.deps.quota.take(
          invitationQuotaDigest(this.key, 'recipient', email),
          input.quotaOwner === null
            ? null
            : invitationQuotaDigest(this.key, input.quotaOwner.kind, input.quotaOwner.id),
        );
        if (!allowed) {
          result = 'skipped';
        } else {
          const token = buildInvitationToken(invitation.companyId, invitation.id, input.secret);
          await this.deps.mailer.sendCompanyInvitation(email, {
            companyName: input.companyName,
            role: invitation.role,
            link: buildInvitationLink(this.deps.appOrigin, token),
            validDays: INVITATION_VALIDITY_DAYS,
          });
          result = 'sent';
        }
      } catch {
        result = 'failed';
      }
      this.countEmail(result);
      const fields = { invitationId: invitation.id, result };
      if (result === 'failed') this.deps.logger.warn(fields, 'falha ao enviar o convite');
      else this.deps.logger.info(fields, 'envio do convite');
    })()
      .catch(() => undefined)
      .finally(() => {
        this.pending.delete(task);
      });
    this.pending.add(task);
  }
}
