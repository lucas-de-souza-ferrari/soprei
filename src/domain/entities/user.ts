import type { WithoutClientId } from '../repositories/tenant.repository.js';
import type { ClientId } from '../value-objects/client-id.js';
import type { PlatformAdminId, UserId } from '../value-objects/user-id.js';

/**
 * Papéis de `User` (specs 007 e 008). O que cada papel pode fazer está em `permissions.ts`; o
 * token carrega só o papel e as permissões são derivadas no servidor.
 */
export const USER_ROLES = ['OWNER', 'ADMIN', 'AGENT', 'VIEWER'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** Tamanho máximo de um e-mail (RFC 5321). */
export const EMAIL_MAX_LENGTH = 254;

/**
 * Pessoa de um cliente (model de tenant). Esta entidade **não** tem o hash da senha: ele só sai
 * em `UserCredentials`, devolvido pela busca de login. O e-mail é dado pessoal: nunca em log.
 */
export interface User {
  readonly id: UserId;
  readonly clientId: ClientId;
  /** Normalizado (NFKC, trim, minúsculas); único por cliente. */
  readonly email: string;
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Dados de criação. Sem `clientId` (vem do parâmetro do repositório). */
export interface NewUser extends WithoutClientId {
  readonly email: string;
  readonly passwordHash: string;
  readonly role?: UserRole;
  readonly status?: UserStatus;
}

export interface UserUpdate extends WithoutClientId {
  readonly role?: UserRole;
  readonly status?: UserStatus;
}

/** O que o login precisa: o usuário e o hash da senha. Nunca serializar nem logar. */
export interface UserCredentials {
  readonly user: User;
  readonly passwordHash: string;
}

/** Operador da plataforma (model global): não pertence a cliente algum. */
export interface PlatformAdmin {
  readonly id: PlatformAdminId;
  readonly email: string;
  readonly status: UserStatus;
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
}
