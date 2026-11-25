import type { AccountId, PlatformAdminId } from '../value-objects/account-id.js';
import type { CompanyId } from '../value-objects/company-id.js';

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
  readonly reason: PlatformActionReason | null;
  readonly createdAt: Date;
}

export interface NewPlatformAuditEvent {
  readonly adminId: PlatformAdminId;
  readonly action: PlatformAuditAction;
  readonly subjectCompanyId?: CompanyId | null;
  readonly subjectAccountId?: AccountId | null;
  readonly reason?: PlatformActionReason | null;
}
