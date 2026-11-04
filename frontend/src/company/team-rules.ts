/**
 * Regras da tela de equipe (spec 025) como funções puras. O espelho de `canManageRole` do backend
 * (`backend/src/domain/permissions.ts`) decide só **o que mostrar**: o servidor reaplica a hierarquia em
 * toda operação e é a barreira de verdade.
 */
export type Role = 'OWNER' | 'ADMIN' | 'AGENT' | 'VIEWER';
export type InvitableRole = 'ADMIN' | 'AGENT' | 'VIEWER';

export const ROLES: readonly Role[] = ['OWNER', 'ADMIN', 'AGENT', 'VIEWER'];
export const INVITABLE_ROLES: readonly InvitableRole[] = ['ADMIN', 'AGENT', 'VIEWER'];

export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  OWNER: 'Proprietário',
  ADMIN: 'Administrador',
  AGENT: 'Atendente',
  VIEWER: 'Somente leitura',
};

export const MEMBER_STATUS_LABELS = { ACTIVE: 'Ativo', DISABLED: 'Desativado' } as const;
export const INVITATION_STATE_LABELS = { PENDING: 'Pendente', EXPIRED: 'Vencido' } as const;

/** Intervalo mínimo entre dois envios do mesmo convite (o servidor decide; aqui é só a dica). */
export const RESEND_INTERVAL_MS = 60_000;

/**
 * Hierarquia dentro de `membership:manage`: `OWNER` gerencia qualquer papel; `ADMIN` só `AGENT` e
 * `VIEWER`; `AGENT`, `VIEWER` e papel desconhecido não gerenciam ninguém.
 */
export function canManageRole(actor: string, target: string): boolean {
  if (!(ROLES as readonly string[]).includes(target)) return false;
  if (actor === 'OWNER') return true;
  if (actor === 'ADMIN') return target === 'AGENT' || target === 'VIEWER';
  return false;
}

/** Papéis que o ator pode atribuir ao convidar (`OWNER` nunca é convidável). */
export function invitableRoles(actor: string): InvitableRole[] {
  return INVITABLE_ROLES.filter((role) => canManageRole(actor, role));
}

/** Papéis que o ator pode atribuir a um membro existente (o `OWNER` promove a `OWNER`). */
export function assignableRoles(actor: string): Role[] {
  return ROLES.filter((role) => canManageRole(actor, role));
}

export interface MemberActions {
  /** Pode mudar o papel (select) e desativar/reativar. Nunca na própria linha nem acima da hierarquia. */
  readonly manage: boolean;
}

export function memberActions(
  actorRole: string,
  actorMembershipId: string,
  member: { readonly id: string; readonly role: string },
): MemberActions {
  return { manage: member.id !== actorMembershipId && canManageRole(actorRole, member.role) };
}

/** Mudar o papel de `OWNER` ou `ADMIN` pede confirmação (desativar sempre pede). */
export function roleChangeNeedsConfirmation(currentRole: string): boolean {
  return currentRole === 'OWNER' || currentRole === 'ADMIN';
}

/** Segundos até o reenvio liberar, pelo `lastSentAt` e o relógio do navegador (só dica de tela). */
export function resendWaitSeconds(lastSentAt: string, nowMs: number): number {
  const sent = Date.parse(lastSentAt);
  if (Number.isNaN(sent)) return 0;
  return Math.max(0, Math.ceil((sent + RESEND_INTERVAL_MS - nowMs) / 1000));
}

const DATE = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' });
const DATE_TIME = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

export function formatDate(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? '' : DATE.format(time);
}

export function formatDateTime(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? '' : DATE_TIME.format(time);
}
