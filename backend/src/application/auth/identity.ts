import type {
  CompanyId,
  PlatformAdminId,
  MembershipId,
  MembershipRole,
} from '../../domain/index.js';

/** Quem está autenticado: pessoa de uma empresa ou operador da plataforma. */
export interface MembershipIdentity {
  readonly kind: 'membership';
  readonly membershipId: MembershipId;
  /** Sempre do token assinado; nunca de cabeçalho, corpo ou URL. */
  readonly companyId: CompanyId;
  readonly role: MembershipRole;
  readonly sessionId: string;
}

export interface PlatformIdentity {
  readonly kind: 'platform';
  readonly adminId: PlatformAdminId;
  readonly sessionId: string;
}

export type AuthIdentity = MembershipIdentity | PlatformIdentity;

/** Escopo das chaves de sessão: o `CompanyId` de um usuário, ou `platform`. */
export const PLATFORM_SCOPE = 'platform';

export function scopeOf(identity: AuthIdentity): string {
  return identity.kind === 'membership' ? identity.companyId : PLATFORM_SCOPE;
}

export function subjectIdOf(identity: AuthIdentity): string {
  return identity.kind === 'membership' ? identity.membershipId : identity.adminId;
}
