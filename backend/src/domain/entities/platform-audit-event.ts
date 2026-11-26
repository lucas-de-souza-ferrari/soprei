import type { AccountId, PlatformAdminId } from '../value-objects/account-id.js';
import type { CompanyId } from '../value-objects/company-id.js';
import type { MembershipId } from '../value-objects/membership-id.js';
import type { PlanCode } from '../billing.js';
import type { MembershipRole } from './membership.js';

/**
 * Ações da trilha da plataforma (spec 044). A E1 grava entrada e saída; as outras são das etapas
 * seguintes (suspender e reativar empresa, ler o e-mail completo de uma conta).
 */
export const PLATFORM_AUDIT_ACTIONS = [
  'PLATFORM_LOGIN',
  'PLATFORM_LOGOUT',
  'COMPANY_SUSPENDED',
  'COMPANY_REACTIVATED',
  'ACCOUNT_EMAIL_VIEWED',
  // Spec 045, E2: ações sobre a conta.
  'ACCOUNT_DISABLED',
  'ACCOUNT_ENABLED',
  'ACCOUNT_SESSIONS_REVOKED',
  'ACCOUNT_PASSWORD_RESET_SENT',
  'ACCOUNT_VERIFICATION_SENT',
  // Spec 045, E3a: ações sobre empresa e vínculos.
  'COMPANY_RENAMED',
  'COMPANY_REMOVED',
  'COMPANY_RESTORED',
  'MEMBERSHIP_ROLE_CHANGED_BY_PLATFORM',
  'MEMBERSHIP_DISABLED_BY_PLATFORM',
  'MEMBERSHIP_ENABLED_BY_PLATFORM',
  // Spec 045, E3b: convites da plataforma e criar empresa com o convite do dono.
  'COMPANY_CREATED',
  'INVITATION_CREATED_BY_PLATFORM',
  'INVITATION_RESENT_BY_PLATFORM',
  'INVITATION_REVOKED_BY_PLATFORM',
  // Spec 045, E4: assinatura e módulos da conta.
  'SUBSCRIPTION_TRIAL_STARTED',
  'SUBSCRIPTION_EXTENDED',
  'SUBSCRIPTION_MODULES_CHANGED',
  'SUBSCRIPTION_PLAN_CHANGED',
  'SUBSCRIPTION_CANCELLED',
  'SUBSCRIPTION_REACTIVATED',
  'SUBSCRIPTION_ENDED',
  // Spec 045, E5: canal.
  'CHANNEL_DISCONNECTED_BY_PLATFORM',
] as const;
export type PlatformAuditAction = (typeof PLATFORM_AUDIT_ACTIONS)[number];

/** Motivo fixo das ações sobre empresa (spec 044, D1); nunca texto livre. */
export const PLATFORM_ACTION_REASONS = ['PAYMENT', 'ABUSE', 'OWNER_REQUEST', 'OTHER'] as const;
export type PlatformActionReason = (typeof PLATFORM_ACTION_REASONS)[number];

/**
 * Evento da trilha da plataforma (model **global**, imutável). Sem texto livre, sem e-mail, sem IP:
 * só ids e valores de enum. `subjectCompanyId` e `subjectAccountId` dizem sobre quem foi a ação (o
 * nome não é `companyId` de propósito: o evento não pertence à empresa, é do administrador).
 */
export interface PlatformAuditEvent {
  readonly id: string;
  readonly adminId: PlatformAdminId;
  readonly action: PlatformAuditAction;
  readonly subjectCompanyId: CompanyId | null;
  readonly subjectAccountId: AccountId | null;
  /** Spec 045, E3a: o vínculo alvo e os papéis de antes e de depois (só nas ações sobre vínculos). */
  readonly subjectMembershipId: MembershipId | null;
  /** Spec 045, E3b: o convite alvo (convidar, reenviar, revogar pela plataforma). */
  readonly subjectInvitationId: string | null;
  readonly fromRole: MembershipRole | null;
  readonly toRole: MembershipRole | null;
  /** Spec 045, E4: plano trocado, dias concedidos e módulos ligados (só nas ações da assinatura). */
  readonly planCode: PlanCode | null;
  readonly days: number | null;
  readonly moduleSchedule: boolean | null;
  readonly moduleInventory: boolean | null;
  readonly reason: PlatformActionReason | null;
  readonly createdAt: Date;
}

export interface NewPlatformAuditEvent {
  readonly adminId: PlatformAdminId;
  readonly action: PlatformAuditAction;
  readonly subjectCompanyId?: CompanyId | null;
  readonly subjectAccountId?: AccountId | null;
  readonly subjectMembershipId?: MembershipId | null;
  readonly subjectInvitationId?: string | null;
  readonly fromRole?: MembershipRole | null;
  readonly toRole?: MembershipRole | null;
  readonly planCode?: PlanCode | null;
  readonly days?: number | null;
  readonly moduleSchedule?: boolean | null;
  readonly moduleInventory?: boolean | null;
  readonly reason?: PlatformActionReason | null;
}
