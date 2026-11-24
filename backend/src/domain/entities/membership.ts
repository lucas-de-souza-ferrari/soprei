import type { WithoutCompanyId } from '../repositories/tenant.repository.js';
import type { CompanyId } from '../value-objects/company-id.js';
import type { MembershipId } from '../value-objects/membership-id.js';
import type { PlatformAdminId } from '../value-objects/account-id.js';

/**
 * Papéis de `Membership` (specs 007 e 008). O que cada papel pode fazer está em `permissions.ts`; o
 * token carrega só o papel e as permissões são derivadas no servidor.
 */
export const MEMBERSHIP_ROLES = ['OWNER', 'ADMIN', 'AGENT', 'VIEWER'] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export const ACCESS_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export type AccessStatus = (typeof ACCESS_STATUSES)[number];

/** Tamanho máximo de um e-mail (RFC 5321). */
export const EMAIL_MAX_LENGTH = 254;

/**
 * Pessoa de uma empresa (model de tenant). Esta entidade **não** tem o hash da senha: ele só sai
 * em `MembershipCredentials`, devolvido pela busca de login. O e-mail é dado pessoal: nunca em log.
 */
export interface Membership {
  readonly id: MembershipId;
  readonly companyId: CompanyId;
  /** Normalizado (NFKC, trim, minúsculas); único por empresa. */
  readonly email: string;
  readonly role: MembershipRole;
  readonly status: AccessStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Dados de criação. Sem `companyId` (vem do parâmetro do repositório). */
export interface NewMembership extends WithoutCompanyId {
  readonly email: string;
  readonly passwordHash: string;
  readonly role?: MembershipRole;
  readonly status?: AccessStatus;
}

export interface MembershipUpdate extends WithoutCompanyId {
  readonly role?: MembershipRole;
  readonly status?: AccessStatus;
}

/** O que o login precisa: o usuário e o hash da senha. Nunca serializar nem logar. */
export interface MembershipCredentials {
  readonly membership: Membership;
  readonly passwordHash: string;
}

/** Operador da plataforma (model global): não pertence a empresa algum. */
export interface PlatformAdmin {
  readonly id: PlatformAdminId;
  readonly email: string;
  readonly status: AccessStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewPlatformAdmin {
  readonly email: string;
  readonly passwordHash: string;
}

export interface PlatformAdminCredentials {
  readonly admin: PlatformAdmin;
  readonly passwordHash: string;
  /** Segredo TOTP cifrado (spec 044); nulo = segundo fator não cadastrado. Nunca em log nem resposta. */
  readonly totpSecretCiphertext: string | null;
}
