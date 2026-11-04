import { MEMBERSHIP_ROLES, type MembershipRole } from './entities/membership.js';

/**
 * Permissões (spec 008): lista fixa em código. Rotas declaram **permissões**, nunca papéis; o
 * mapa papel -> permissões abaixo é a única fonte (versionada e testada por snapshot), então
 * mudá-lo vale na hora, sem reemitir tokens (o token carrega só o papel).
 */
export const PERMISSIONS = [
  'conversation:read',
  'conversation:simulate',
  'membership:read',
  'membership:manage',
  'audit:read',
  'channel:read',
  'channel:manage',
  'persona:manage',
  'knowledge:manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Readonly<Record<MembershipRole, readonly Permission[]>> = {
  OWNER: [
    'conversation:read',
    'conversation:simulate',
    'membership:read',
    'membership:manage',
    'audit:read',
    'channel:read',
    'channel:manage',
    'persona:manage',
    'knowledge:manage',
  ],
  ADMIN: [
    'conversation:read',
    'conversation:simulate',
    'membership:read',
    'membership:manage',
    'audit:read',
    'channel:read',
    'channel:manage',
    'persona:manage',
    'knowledge:manage',
  ],
  AGENT: ['conversation:read', 'conversation:simulate'],
  VIEWER: ['conversation:read'],
};

function isMembershipRole(value: unknown): value is MembershipRole {
  return (MEMBERSHIP_ROLES as readonly unknown[]).includes(value);
}

/**
 * O papel tem a permissão? Papel desconhecido (fora de `MEMBERSHIP_ROLES`) **nunca** concede nada, mesmo
 * que chegue aqui por um caminho que a tipagem não cobre.
 */
export function hasPermission(role: unknown, permission: Permission): boolean {
  if (!isMembershipRole(role)) return false;
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * Hierarquia dentro de `membership:manage` (spec 008). Vale para os dois lados de uma operação: o papel
 * **atual** do alvo e o papel que se quer **atribuir**. `OWNER` gerencia qualquer papel; `ADMIN` só
 * `AGENT` e `VIEWER` (não toca em `OWNER` nem em outro `ADMIN`, nem promove ninguém a eles);
 * `AGENT`, `VIEWER` e papel desconhecido não gerenciam ninguém.
 */
export function canManageRole(actor: unknown, target: unknown): boolean {
  if (!isMembershipRole(target)) return false;
  if (actor === 'OWNER') return true;
  if (actor === 'ADMIN') return target === 'AGENT' || target === 'VIEWER';
  return false;
}
