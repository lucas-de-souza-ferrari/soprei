import { z } from 'zod';
import { ApiError, request } from '../api';
import {
  type Failure,
  FORBIDDEN_MESSAGE,
  GENERIC_MESSAGE,
  RATE_MESSAGE,
  UNAVAILABLE_MESSAGE,
} from './company-api';
import type { InvitableRole, Role } from './team-rules';

/**
 * Contratos e mensagens da equipe (spec 025). Toda mensagem da tela é escolhida aqui pelo `status` e
 * pelo `error.code`; o texto de erro do servidor nunca é lido nem mostrado. Os contratos são estritos:
 * campo desconhecido é recusado (a tela falha em vez de exibir algo que não conhece).
 */
export const TEAM_PAGE_SIZE = 30;

const isoDate = z.iso.datetime();
const cursorText = z.string().min(1).max(512);
const role = z.enum(['OWNER', 'ADMIN', 'AGENT', 'VIEWER']);

export const memberSchema = z.strictObject({
  id: z.uuid(),
  email: z.string().min(1).max(254),
  role,
  status: z.enum(['ACTIVE', 'DISABLED']),
  createdAt: isoDate,
});
export type Member = z.infer<typeof memberSchema>;

export const membersPageSchema = z.strictObject({
  items: z.array(memberSchema).max(200),
  nextCursor: cursorText.nullable(),
});

export const invitationSchema = z.strictObject({
  id: z.uuid(),
  email: z.string().min(1).max(254),
  // Spec 045, E3b: o convite da plataforma pode ser de dono e vem marcado (a equipe revoga, não reenvia).
  role: z.enum(['OWNER', 'ADMIN', 'AGENT', 'VIEWER']),
  state: z.enum(['PENDING', 'EXPIRED']),
  createdAt: isoDate,
  expiresAt: isoDate,
  lastSentAt: isoDate,
  sendCount: z.number().int().min(1).max(6),
  fromPlatform: z.boolean(),
});
export type InvitationItem = z.infer<typeof invitationSchema>;

export const invitationsPageSchema = z.strictObject({
  items: z.array(invitationSchema).max(200),
  nextCursor: cursorText.nullable(),
});

interface PageParams {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

function queryOf(params: PageParams): string {
  const query = new URLSearchParams();
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.cursor !== undefined) query.set('cursor', params.cursor);
  const text = query.toString();
  return text === '' ? '' : `?${text}`;
}

const companyPath = (companyId: string): string => `/admin/companies/${companyId}`;
const part = (id: string): string => encodeURIComponent(id);

export const teamApi = {
  members: async (companyId: string, params: PageParams = {}) =>
    membersPageSchema.parse(
      await request(`${companyPath(companyId)}/memberships${queryOf(params)}`),
    ),
  updateMember: async (
    companyId: string,
    membershipId: string,
    change: { role?: Role; status?: 'ACTIVE' | 'DISABLED' },
  ) =>
    memberSchema.parse(
      await request(`${companyPath(companyId)}/memberships/${part(membershipId)}`, {
        method: 'PATCH',
        body: change,
      }),
    ),
  invitations: async (companyId: string, params: PageParams = {}) =>
    invitationsPageSchema.parse(
      await request(`${companyPath(companyId)}/invitations${queryOf(params)}`),
    ),
  invite: async (companyId: string, body: { email: string; role: InvitableRole }) =>
    invitationSchema.parse(
      await request(`${companyPath(companyId)}/invitations`, { method: 'POST', body }),
    ),
  resend: async (companyId: string, invitationId: string) =>
    invitationSchema.parse(
      await request(`${companyPath(companyId)}/invitations/${part(invitationId)}/resend`, {
        method: 'POST',
      }),
    ),
  revoke: async (companyId: string, invitationId: string): Promise<void> => {
    await request(`${companyPath(companyId)}/invitations/${part(invitationId)}`, {
      method: 'DELETE',
    });
  },
};

export const LAST_OWNER_MESSAGE = 'A empresa precisa ter ao menos um proprietário ativo.';
export const MEMBER_EXISTS_MESSAGE = 'Essa pessoa já faz parte da equipe.';
export const ALREADY_PENDING_MESSAGE =
  'Já existe um convite pendente para este e-mail. Use "Reenviar" na lista de convites.';
export const LIMIT_MESSAGE = 'Limite de convites atingido. Tente novamente mais tarde.';
export const NOT_PENDING_MESSAGE = 'Este convite não está mais pendente. A lista foi atualizada.';
export const INVALID_INPUT_MESSAGE = 'Confira o e-mail e o papel informados.';
export const STALE_MESSAGE = 'Este item não existe mais. A lista foi atualizada.';

const CODE_MESSAGES: Readonly<Record<string, string>> = {
  LAST_OWNER: LAST_OWNER_MESSAGE,
  MEMBER_ALREADY_EXISTS: MEMBER_EXISTS_MESSAGE,
  INVITATION_ALREADY_PENDING: ALREADY_PENDING_MESSAGE,
  INVITATION_LIMIT_REACHED: LIMIT_MESSAGE,
  INVITATION_NOT_PENDING: NOT_PENDING_MESSAGE,
};

/** Traduz uma falha da API da equipe em ação de tela. Ignora por completo o texto do corpo de erro. */
export function teamFailureOf(error: unknown): Failure {
  if (!(error instanceof ApiError)) return { kind: 'message', text: GENERIC_MESSAGE };
  const { status, code } = error;
  if (status === 401) return { kind: 'session' };
  if (status === 404) return { kind: 'changed' };
  const known = code === undefined ? undefined : CODE_MESSAGES[code];
  if (known !== undefined) return { kind: 'message', text: known };
  if (status === 400) return { kind: 'message', text: INVALID_INPUT_MESSAGE };
  if (status === 403) return { kind: 'message', text: FORBIDDEN_MESSAGE };
  if (status === 429) return { kind: 'message', text: RATE_MESSAGE };
  if (status === 502 || status === 503) return { kind: 'message', text: UNAVAILABLE_MESSAGE };
  return { kind: 'message', text: GENERIC_MESSAGE };
}
