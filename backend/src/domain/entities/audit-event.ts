import type { WithoutCompanyId } from '../repositories/tenant.repository.js';
import type { CompanyId } from '../value-objects/company-id.js';
import type { MembershipRole } from './membership.js';

/** Ações auditadas (spec 008); o valor vira label da métrica `membership_admin_actions_total`. */
export const AUDIT_ACTIONS = [
  'MEMBERSHIP_CREATED',
  'MEMBERSHIP_ROLE_CHANGED',
  'MEMBERSHIP_DISABLED',
  'MEMBERSHIP_ENABLED',
  'MEMBERSHIP_PASSWORD_RESET',
  'MEMBERSHIP_PASSWORD_CHANGED',
  'CHANNEL_CONNECTED',
  'CHANNEL_TOKEN_REPLACED',
  'CHANNEL_DISCONNECTED',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Evento da trilha de auditoria (model de tenant, imutável). Sem texto livre, sem e-mail, sem IP:
 * só ids e valores de enum. Os ids de pessoa são dado pessoal indireto.
 */
export interface AuditEvent {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly action: AuditAction;
  readonly actorMembershipId: string;
  /** Nulo nas ações `CHANNEL_*` (spec 015). */
  readonly targetMembershipId: string | null;
  readonly fromRole: MembershipRole | null;
  readonly toRole: MembershipRole | null;
  readonly createdAt: Date;
}

/** Dados de criação. Sem `companyId` (vem do parâmetro do repositório). */
export interface NewAuditEvent extends WithoutCompanyId {
  readonly action: AuditAction;
  readonly actorMembershipId: string;
  /** Obrigatório nas ações `MEMBERSHIP_*`; ausente nas `CHANNEL_*` (o banco confere com um CHECK). */
  readonly targetMembershipId?: string | null;
  readonly fromRole?: MembershipRole | null;
  readonly toRole?: MembershipRole | null;
}
