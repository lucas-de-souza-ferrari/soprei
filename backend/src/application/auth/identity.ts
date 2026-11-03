import type { ClientId, PlatformAdminId, UserId, UserRole } from '../../domain/index.js';

/** Quem está autenticado: pessoa de um cliente ou operador da plataforma. */
export interface UserIdentity {
  readonly kind: 'user';
  readonly userId: UserId;
  /** Sempre do token assinado; nunca de cabeçalho, corpo ou URL. */
  readonly clientId: ClientId;
  readonly role: UserRole;
  readonly sessionId: string;
}

export interface PlatformIdentity {
  readonly kind: 'platform';
  readonly adminId: PlatformAdminId;
  readonly sessionId: string;
}

export type AuthIdentity = UserIdentity | PlatformIdentity;

/** Escopo das chaves de sessão: o `ClientId` de um usuário, ou `platform`. */
export const PLATFORM_SCOPE = 'platform';

export function scopeOf(identity: AuthIdentity): string {
  return identity.kind === 'user' ? identity.clientId : PLATFORM_SCOPE;
}

export function subjectIdOf(identity: AuthIdentity): string {
  return identity.kind === 'user' ? identity.userId : identity.adminId;
}
