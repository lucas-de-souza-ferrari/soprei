import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { SENTINEL, type Call, type FakeApi } from './company-fixture';

export type TeamRole = 'OWNER' | 'ADMIN' | 'AGENT' | 'VIEWER';

export interface FakeMember {
  id: string;
  email: string;
  role: TeamRole;
  status: 'ACTIVE' | 'DISABLED';
  createdAt: string;
}

export interface FakeInvitation {
  id: string;
  email: string;
  role: 'ADMIN' | 'AGENT' | 'VIEWER';
  state: 'PENDING' | 'EXPIRED';
  createdAt: string;
  expiresAt: string;
  lastSentAt: string;
  sendCount: number;
}

/** Estado da API falsa da equipe (spec 025): camada por cima da API falsa da área da empresa. */
export interface FakeTeam {
  /** Membros por empresa. */
  members: Record<string, FakeMember[]>;
  invitations: Record<string, FakeInvitation[]>;
  /** Chamadas às rotas da equipe (a API base não as vê: esta camada responde antes). */
  calls: Call[];
  /** Falhas ligadas (flags, não contadores: o StrictMode repete efeitos). */
  failMembers: boolean;
  /** Resposta forçada do próximo `POST` de convite (um erro com `code`). */
  inviteError: { status: number; code: string } | null;
  resendError: { status: number; code: string } | null;
  patchError: { status: number; code: string } | null;
  /** Segura a leitura de membros de uma empresa até `release()`. */
  membersGate: { companyId: string; promise: Promise<void> } | null;
  /** Relógio da API falsa (o do Node não acompanha o `page.clock`); `null` = relógio real. */
  clockMs: number | null;
  release: () => void;
}

export function person(email: string, role: TeamRole, extra: Partial<FakeMember> = {}): FakeMember {
  return {
    id: randomUUID(),
    email,
    role,
    status: 'ACTIVE',
    createdAt: '2026-10-01T12:00:00.000Z',
    ...extra,
  };
}

export function invitation(
  email: string,
  role: FakeInvitation['role'] = 'AGENT',
  extra: Partial<FakeInvitation> = {},
): FakeInvitation {
  const sent = new Date(Date.now() - 10 * 60_000).toISOString();
  return {
    id: randomUUID(),
    email,
    role,
    state: 'PENDING',
    createdAt: sent,
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    lastSentAt: sent,
    sendCount: 1,
    ...extra,
  };
}

export function newTeam(): FakeTeam {
  return {
    members: {},
    invitations: {},
    calls: [],
    failMembers: false,
    inviteError: null,
    resendError: null,
    patchError: null,
    membersGate: null,
    clockMs: null,
    release: () => undefined,
  };
}

/** Segura a leitura de membros da empresa até `team.release()`. */
export function holdMembers(team: FakeTeam, companyId: string): void {
  team.membersGate = {
    companyId,
    promise: new Promise<void>((resolve) => {
      team.release = () => {
        team.membersGate = null;
        resolve();
      };
    }),
  };
}

/**
 * Responde as rotas da equipe. Registrada **depois** de `installApi`: o Playwright consulta o último
 * handler primeiro, e `route.fallback()` entrega o resto à API falsa base.
 */
export async function installTeamApi(page: Page, api: FakeApi, team: FakeTeam): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api', '');
    const method = request.method();
    const match =
      /^\/admin\/companies\/([^/]+)\/(memberships|invitations)(?:\/([^/]+))?(\/resend)?$/.exec(
        path,
      );
    if (match === null) return route.fallback();
    const [, companyId = '', kind, itemId, resend] = match;
    const body: unknown =
      method === 'GET' || method === 'DELETE' ? undefined : request.postDataJSON();
    team.calls.push({ method, path, body });
    const reply = (status: number, json?: unknown) =>
      route.fulfill({ status, ...(json === undefined ? {} : { json }) });
    const fail = (status: number, code: string) =>
      reply(status, { error: { code, message: SENTINEL, requestId: 'x' } });
    const current = api.companies.find((item) => item.companyId === api.selected);
    if (companyId !== api.selected || current === undefined) return fail(404, 'NOT_FOUND');
    const manage = current.permissions.includes('membership:manage');
    const read = current.permissions.includes('membership:read');
    const stamp = (): string => new Date(team.clockMs ?? Date.now()).toISOString();
    const members = (team.members[companyId] ??= []);
    const invitations = (team.invitations[companyId] ??= []);

    const page_ = <T>(rows: T[]) => {
      const offset = url.searchParams.has('cursor') ? Number(url.searchParams.get('cursor')) : 0;
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const next = offset + limit < rows.length ? String(offset + limit) : null;
      return { items: rows.slice(offset, offset + limit), nextCursor: next };
    };

    if (kind === 'memberships') {
      if (method === 'GET' && itemId === undefined) {
        if (!read) return fail(403, 'FORBIDDEN');
        if (team.membersGate !== null && team.membersGate.companyId === companyId) {
          await team.membersGate.promise;
        }
        if (team.failMembers) return fail(500, 'INTERNAL_ERROR');
        return reply(200, page_(members));
      }
      if (method === 'PATCH' && itemId !== undefined) {
        if (!manage) return fail(403, 'FORBIDDEN');
        if (team.patchError !== null) return fail(team.patchError.status, team.patchError.code);
        const target = members.find((item) => item.id === itemId);
        if (target === undefined) return fail(404, 'NOT_FOUND');
        Object.assign(target, body as Partial<FakeMember>);
        return reply(200, target);
      }
      return fail(404, 'NOT_FOUND');
    }

    // invitations
    if (method === 'GET' && itemId === undefined) {
      if (!read) return fail(403, 'FORBIDDEN');
      return reply(200, page_(invitations));
    }
    if (!manage) return fail(403, 'FORBIDDEN');
    if (method === 'POST' && itemId === undefined) {
      if (team.inviteError !== null) return fail(team.inviteError.status, team.inviteError.code);
      const input = body as { email: string; role: FakeInvitation['role'] };
      if (members.some((item) => item.email === input.email)) {
        return fail(409, 'MEMBER_ALREADY_EXISTS');
      }
      if (invitations.some((item) => item.email === input.email)) {
        return fail(409, 'INVITATION_ALREADY_PENDING');
      }
      const created = invitation(input.email, input.role, {
        lastSentAt: stamp(),
        createdAt: stamp(),
      });
      invitations.push(created);
      return reply(201, created);
    }
    const target = invitations.find((item) => item.id === itemId);
    if (target === undefined) return fail(404, 'NOT_FOUND');
    if (method === 'POST' && resend !== undefined) {
      if (team.resendError !== null) return fail(team.resendError.status, team.resendError.code);
      target.lastSentAt = stamp();
      target.sendCount += 1;
      return reply(200, target);
    }
    if (method === 'DELETE') {
      invitations.splice(invitations.indexOf(target), 1);
      return reply(204);
    }
    return fail(404, 'NOT_FOUND');
  });
}
