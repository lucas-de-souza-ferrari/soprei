import type { WithoutClientId } from '../repositories/tenant.repository.js';
import type { ClientId } from '../value-objects/client-id.js';
import type { UserRole } from './user.js';

/** Ações auditadas (spec 008); o valor vira label da métrica `user_admin_actions_total`. */
export const AUDIT_ACTIONS = [
  'USER_CREATED',
  'USER_ROLE_CHANGED',
  'USER_DISABLED',
  'USER_ENABLED',
  'USER_PASSWORD_RESET',
  'USER_PASSWORD_CHANGED',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Evento da trilha de auditoria (model de tenant, imutável). Sem texto livre, sem e-mail, sem IP:
 * só ids e valores de enum. Os ids de pessoa são dado pessoal indireto.
 */
export interface AuditEvent {
  readonly id: string;
  readonly clientId: ClientId;
  readonly action: AuditAction;
  readonly actorUserId: string;
  readonly targetUserId: string;
  readonly fromRole: UserRole | null;
  readonly toRole: UserRole | null;
  readonly createdAt: Date;
}

/** Dados de criação. Sem `clientId` (vem do parâmetro do repositório). */
export interface NewAuditEvent extends WithoutClientId {
  readonly action: AuditAction;
  readonly actorUserId: string;
  readonly targetUserId: string;
  readonly fromRole?: UserRole | null;
  readonly toRole?: UserRole | null;
}
