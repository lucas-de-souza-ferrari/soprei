import type { FastifyBaseLogger } from 'fastify';
import {
  type AccessStatus,
  CompanyId,
  MembershipId,
  type MembershipRole,
  type PlatformActionReason,
  type PlatformAuditAction,
} from '../../domain/index.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors/index.js';
import { isUuid } from '../../shared/utils/index.js';
import type { PlatformIdentity } from '../auth/identity.js';
import { COMPANY_NAME_MAX_LENGTH } from '../companies/company.service.js';
import type {
  PlatformCompanyTransaction,
  PlatformCompanyUnitOfWork,
  PlatformLockedMembership,
  PlatformRemovedChannel,
} from '../ports/platform-company-unit-of-work.js';
import type { SessionStore } from '../ports/session-store.js';
import {
  confirmationInvalid,
  confirmPlatformAction,
  type PlatformActionConfirmer,
} from './platform-confirmation.js';

/** O slug digitado na remoção não confere (spec 045, E3a). */
export const CONFIRMATION_MISMATCH = 'CONFIRMATION_MISMATCH';

/** Desassinar o app da WABA depois de remover a empresa (o `ChannelConnectionService`, só com o canal). */
export interface PlatformChannelRelease {
  unsubscribeRemoved(companyId: CompanyId, removed: PlatformRemovedChannel): Promise<void>;
}

export interface PlatformCompanyServiceDeps {
  readonly companies: PlatformCompanyUnitOfWork;
  readonly confirmer: PlatformActionConfirmer;
  /** Sessões Bearer dos vínculos (`revokeAllSessions`, spec 007/008). */
  readonly bearerSessions: Pick<SessionStore, 'revokeAllSessions'>;
  /** Sem o canal ligado (`WHATSAPP_ENABLED`), não há o que desassinar. */
  readonly channel?: PlatformChannelRelease | undefined;
  readonly logger: FastifyBaseLogger;
  readonly metrics?: Pick<Metrics, 'countPlatformAction'> | undefined;
  readonly now?: () => Date;
}

type PlatformActionMetric = Parameters<Metrics['countPlatformAction']>[0];

const METRIC: Partial<Record<PlatformAuditAction, PlatformActionMetric>> = {
  COMPANY_RENAMED: 'company_renamed',
  COMPANY_REMOVED: 'company_removed',
  COMPANY_RESTORED: 'company_restored',
  MEMBERSHIP_ROLE_CHANGED_BY_PLATFORM: 'membership_role_changed_by_platform',
  MEMBERSHIP_DISABLED_BY_PLATFORM: 'membership_disabled_by_platform',
  MEMBERSHIP_ENABLED_BY_PLATFORM: 'membership_enabled_by_platform',
};

function companyNotFound(): NotFoundError {
  return new NotFoundError('Empresa não encontrada', { context: { entity: 'Company' } });
}

function membershipNotFound(): NotFoundError {
  return new NotFoundError('Vínculo não encontrado', { context: { entity: 'Membership' } });
}

function lastOwner(): ConflictError {
  return new ConflictError('A empresa ficaria sem dono ativo', { code: 'LAST_OWNER' });
}

function notEligible(): ConflictError {
  return new ConflictError('A pessoa não pode receber este papel ou estado', {
    code: 'MEMBER_NOT_ELIGIBLE',
  });
}

/** "Dono ativo" (regra comum 11): vínculo `OWNER` `ACTIVE` com a conta `ACTIVE`, ou sem conta. */
function isActiveOwner(membership: PlatformLockedMembership): boolean {
  return (
    membership.role === 'OWNER' &&
    membership.status === 'ACTIVE' &&
    (membership.account === null || membership.account.status === 'ACTIVE')
  );
}

/**
 * Ações do admin da plataforma sobre uma empresa e os vínculos dela (spec 045, E3a): renomear, remover e
 * restaurar a empresa; mudar o papel, desativar e reativar um vínculo. Cada uma: trava da empresa,
 * releitura, regra, escrita e `PlatformAuditEvent` na mesma transação; o que é externo (Redis, Meta) só
 * depois do commit. Vínculo procurado pelo par (empresa do caminho, id): de outra empresa é 404. Não
 * conhece Fastify nem Prisma. Nunca loga nome de empresa, slug, e-mail nem código: só ids, ação e motivo.
 */
export class PlatformCompanyService {
  constructor(private readonly deps: PlatformCompanyServiceDeps) {}

  /** Renomeia (as regras de nome do `CompanyService`). Mesmo nome: 204 sem evento. Devolve se mudou. */
  async rename(
    identity: PlatformIdentity,
    companyId: string,
    name: string,
    reason: PlatformActionReason,
  ): Promise<boolean> {
    const id = this.parseCompanyId(companyId);
    const parsed = name.trim();
    if (parsed.length === 0 || parsed.length > COMPANY_NAME_MAX_LENGTH) {
      throw new ValidationError(
        `name deve ter de 1 a ${String(COMPANY_NAME_MAX_LENGTH)} caracteres`,
      );
    }
    const action = 'COMPANY_RENAMED';
    const changed = await this.deps.companies.run(async (tx) => {
      await tx.lockCompany(id);
      if ((await tx.company(id)).name === parsed) return false;
      await tx.rename(id, parsed);
      // A trilha não guarda o nome antigo nem o novo (sem texto livre).
      await tx.audit({ adminId: identity.adminId, action, subjectCompanyId: id, reason });
      return true;
    });
    if (changed) this.recorded(identity, id, action, reason);
    return changed;
  }

  /**
   * Remove a empresa (soft delete, **[código]** e o slug digitado): número liberado, conexão do canal
   * apagada e convites pendentes revogados na mesma transação; depois do commit, desassina o app da WABA em
   * melhor esforço (falha não desfaz nada). Slug errado = 400 `CONFIRMATION_MISMATCH` antes de gastar o
   * código. Já removida: 404 (é o que o detalhe da não removida diz; restaurar é a outra rota).
   */
  async remove(
    identity: PlatformIdentity,
    companyId: string,
    slug: string,
    reason: PlatformActionReason,
    code: string | undefined,
  ): Promise<void> {
    const id = this.parseCompanyId(companyId);
    const state = await this.deps.companies.run((tx) => tx.state(id));
    if (state === null || state.removed) throw companyNotFound();
    if (state.slug !== slug) throw this.mismatch();
    await confirmPlatformAction(this.deps.confirmer, identity, code);
    const action = 'COMPANY_REMOVED';
    const removed = await this.deps.companies.run(async (tx) => {
      await tx.lockCompany(id);
      if ((await tx.company(id)).slug !== slug) throw this.mismatch();
      const channel = await tx.remove(id, this.now());
      await tx.audit({ adminId: identity.adminId, action, subjectCompanyId: id, reason });
      return channel;
    });
    this.recorded(identity, id, action, reason);
    if (removed !== null && this.deps.channel !== undefined) {
      try {
        await this.deps.channel.unsubscribeRemoved(id, removed);
      } catch {
        // O serviço do canal já registra a falha; aqui só garante que nada sobe ao admin.
        this.deps.logger.warn({ companyId: id }, 'desassinatura da WABA falhou depois de remover');
      }
    }
  }

  /**
   * Restaura a empresa removida (**[código]**): limpa o `deletedAt`; o canal não volta (o `OWNER`
   * reconecta). Não removida: 204 sem evento e sem gastar o código. Inexistente: 404. Devolve se restaurou.
   */
  async restore(
    identity: PlatformIdentity,
    companyId: string,
    reason: PlatformActionReason,
    code: string | undefined,
  ): Promise<boolean> {
    const id = this.parseCompanyId(companyId);
    const state = await this.deps.companies.run((tx) => tx.state(id));
    if (state === null) throw companyNotFound();
    if (!state.removed) return false;
    await confirmPlatformAction(this.deps.confirmer, identity, code);
    const action = 'COMPANY_RESTORED';
    const restored = await this.deps.companies.run(async (tx) => {
      if (!(await tx.restore(id))) return false;
      await tx.audit({ adminId: identity.adminId, action, subjectCompanyId: id, reason });
      return true;
    });
    if (restored) this.recorded(identity, id, action, reason);
    return restored;
  }

  /**
   * Muda o papel de um vínculo (**[código]** quando o papel de origem ou o de destino é `OWNER`), sem a
   * hierarquia de vínculo (a plataforma está acima dela), com a regra do último dono sob a trava da
   * empresa. Promover a `OWNER` exige vínculo `ACTIVE` e conta `ACTIVE` e confirmada. Depois do commit,
   * revoga as sessões Bearer do vínculo (Redis fora = 503 com a mudança gravada). Mesmo papel: 204 sem evento
   * e sem gastar o código, mas a revogação é refeita (regra comum 6: repetir depois de um 503 a conclui).
   */
  async changeRole(
    identity: PlatformIdentity,
    companyId: string,
    membershipId: string,
    role: MembershipRole,
    reason: PlatformActionReason,
    code: string | undefined,
  ): Promise<boolean> {
    const id = this.parseCompanyId(companyId);
    const target = this.parseMembershipId(membershipId);
    // O papel atual decide se a confirmação é exigida; ele é relido sob a trava logo abaixo.
    const before = await this.deps.companies.run(async (tx) => {
      await tx.lockCompany(id);
      return tx.membership(id, target);
    });
    if (before === null) throw membershipNotFound();
    if (before.role === role) {
      await this.revokeAfterCommit(id, target);
      return false;
    }
    const confirmed = before.role === 'OWNER' || role === 'OWNER';
    if (confirmed) await confirmPlatformAction(this.deps.confirmer, identity, code);
    const action = 'MEMBERSHIP_ROLE_CHANGED_BY_PLATFORM';
    const outcome = await this.deps.companies.run(async (tx) => {
      const current = await this.lockMembership(tx, id, target);
      if (current.role === role) return null;
      // O papel mudou entre a primeira leitura e a trava e agora envolve OWNER: sem código, nada muda.
      if (!confirmed && current.role === 'OWNER') {
        throw confirmationInvalid();
      }
      if (role === 'OWNER') {
        if (
          current.status !== 'ACTIVE' ||
          current.account === null ||
          current.account.status !== 'ACTIVE' ||
          !current.account.verified
        ) {
          throw notEligible();
        }
      } else if (isActiveOwner(current) && (await tx.activeOwners(id)) <= 1) {
        throw lastOwner();
      }
      await tx.setMembershipRole(id, target, role);
      await tx.audit({
        adminId: identity.adminId,
        action,
        subjectCompanyId: id,
        subjectMembershipId: target,
        fromRole: current.role,
        toRole: role,
        reason,
      });
      return current.role;
    });
    if (outcome === null) {
      await this.revokeAfterCommit(id, target);
      return false;
    }
    this.recorded(identity, id, action, reason, target);
    await this.revokeAfterCommit(id, target);
    return true;
  }

  /**
   * Desativa (`DISABLED`: "remover a pessoa da empresa"; o vínculo nunca é apagado) ou reativa (`ACTIVE`,
   * exige a conta `ACTIVE`) um vínculo. O último dono ativo não é desativado (409 `LAST_OWNER`). Mesmo
   * estado: 204 sem evento. Desativar revoga as sessões Bearer do vínculo depois do commit, também na
   * repetição (regra comum 6: repetir depois de um 503 conclui a revogação).
   */
  async setMembershipStatus(
    identity: PlatformIdentity,
    companyId: string,
    membershipId: string,
    status: AccessStatus,
    reason: PlatformActionReason,
  ): Promise<boolean> {
    const id = this.parseCompanyId(companyId);
    const target = this.parseMembershipId(membershipId);
    const disabling = status === 'DISABLED';
    const action = disabling ? 'MEMBERSHIP_DISABLED_BY_PLATFORM' : 'MEMBERSHIP_ENABLED_BY_PLATFORM';
    const changed = await this.deps.companies.run(async (tx) => {
      const current = await this.lockMembership(tx, id, target);
      if (current.status === status) return false;
      if (disabling) {
        if (isActiveOwner(current) && (await tx.activeOwners(id)) <= 1) throw lastOwner();
      } else if (current.account !== null && current.account.status !== 'ACTIVE') {
        throw notEligible();
      }
      await tx.setMembershipStatus(id, target, status);
      await tx.audit({
        adminId: identity.adminId,
        action,
        subjectCompanyId: id,
        subjectMembershipId: target,
        reason,
      });
      return true;
    });
    if (changed) this.recorded(identity, id, action, reason, target);
    if (disabling) await this.revokeAfterCommit(id, target);
    return changed;
  }

  private async lockMembership(
    tx: PlatformCompanyTransaction,
    companyId: CompanyId,
    membershipId: MembershipId,
  ): Promise<PlatformLockedMembership> {
    await tx.lockCompany(companyId);
    const membership = await tx.membership(companyId, membershipId);
    if (membership === null) throw membershipNotFound();
    return membership;
  }

  private parseCompanyId(companyId: string): CompanyId {
    if (!isUuid(companyId)) throw companyNotFound();
    return CompanyId.parse(companyId);
  }

  private parseMembershipId(membershipId: string): MembershipId {
    if (!isUuid(membershipId)) throw membershipNotFound();
    return MembershipId.parse(membershipId);
  }

  private mismatch(): ValidationError {
    return new ValidationError('O slug digitado não confere', { code: CONFIRMATION_MISMATCH });
  }

  /**
   * As sessões Bearer do vínculo, depois do commit (o cookie da conta já relê o vínculo a cada
   * requisição). Falha do Redis sobe como 503 com a mudança e a trilha gravadas.
   */
  private async revokeAfterCommit(companyId: CompanyId, membershipId: MembershipId): Promise<void> {
    try {
      await this.deps.bearerSessions.revokeAllSessions(companyId, membershipId);
    } catch (error) {
      this.deps.logger.error(
        { companyId, membershipId, reason: 'revocation_failed' },
        'ação da plataforma gravada, mas a revogação das sessões falhou',
      );
      throw error;
    }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private recorded(
    identity: PlatformIdentity,
    companyId: CompanyId,
    action: PlatformAuditAction,
    reason: PlatformActionReason,
    membershipId?: MembershipId,
  ): void {
    const metric = METRIC[action];
    try {
      if (metric !== undefined) this.deps.metrics?.countPlatformAction(metric);
    } catch (error) {
      this.deps.logger.warn({ err: error }, 'falha ao registrar métrica da plataforma');
    }
    this.deps.logger.info(
      { adminId: identity.adminId, companyId, membershipId: membershipId ?? null, action, reason },
      'admin da plataforma agiu sobre uma empresa',
    );
  }
}
