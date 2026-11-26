import type { Page, Request } from '@playwright/test';
import {
  actionBodySchema,
  anonymizeBodySchema,
  confirmedActionBodySchema,
  createCompanyBodySchema,
  extendBodySchema,
  inviteBodySchema,
  modulesBodySchema,
  planBodySchema,
  type Subscription,
  type Invitation,
  removeCompanyBodySchema,
  renameBodySchema,
  roleBodySchema,
  type MembershipRole,
} from '../src/contracts';
import * as fx from './fixtures';

/**
 * API falsa do admin (spec 044, E3), uma por teste, por `page.route`. Imita as regras da E1 e da E2 que a
 * tela percebe: sessão por cookie (aqui um estado em memória), `X-Soprei-App: admin` exigido em `POST`,
 * 401 uniforme no login, 401 em qualquer rota sem sessão e 400 a parâmetro de consulta desconhecido ou
 * com valor fora da lista (os esquemas `.strict()` de `platform-monitor.validators.ts`).
 */
export const GOOD = { email: fx.ADMIN_EMAIL, password: 'senha-do-dono-bem-longa', code: '123456' };
/** Código NOVO do autenticador (spec 045, E2): o do login (`GOOD.code`) já foi usado e é recusado. */
export const FRESH_CODE = '654321';

/** `limit` de 1 a 50 e cursor opaco, como no `pageShape` da E2. */
const PAGE = { limit: /^([1-9]|[1-4][0-9]|50)$/, cursor: /^.{1,512}$/ };

/** Parâmetros aceitos por rota de lista, como nos validadores da E2 (valores em minúsculas). */
const QUERY_RULES: Record<string, Record<string, RegExp>> = {
  '/platform/companies': {
    ...PAGE,
    status: /^(active|suspended|removed)$/,
    q: /^.{0,64}$/,
    attention: /^(pending_messages|unsent_replies|token_invalid|token_expiring|open_handoffs)$/,
  },
  '/platform/accounts': { ...PAGE, status: /^(active|disabled)$/, verified: /^(true|false)$/ },
  '/platform/billing/orders': {
    ...PAGE,
    status: /^(pending|paid|expired|failed)$/,
    kind: /^(new|renewal|upgrade|extra_pack)$/,
  },
  '/platform/billing/notices': { ...PAGE, kind: /^[a-z0-9_]+$/ },
};

function queryAccepted(path: string, search: URLSearchParams): boolean {
  // Spec 045, E3b: a lista de convites aceita só limit e cursor, como o validador do servidor.
  const rules = QUERY_RULES[path] ?? (path.endsWith('/invitations') ? PAGE : {});
  for (const [key, value] of search) {
    const rule = rules[key];
    if (rule === undefined || !rule.test(value)) return false;
  }
  return true;
}

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly search: URLSearchParams;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export interface FakeApiOptions {
  readonly signedIn?: boolean;
  readonly billingEnabled?: boolean;
  readonly queueUnavailable?: boolean;
  /** A conta A é a única dona ativa de uma empresa ativa: desativar responde 409 `LAST_OWNER`. */
  readonly lastOwner?: boolean;
}

export class FakeApi {
  readonly calls: Call[] = [];
  signedIn: boolean;
  companyStatus: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE';
  /** Estado da conta A (spec 045, E2): as ações mudam e o detalhe relê. */
  accountStatus: 'ACTIVE' | 'DISABLED' = 'ACTIVE';
  accountVerified = true;
  /** Remover a conta (E6): a recusa que o servidor daria, ou removida. */
  anonymizeRefusal: 'COMPANY_OWNERSHIP' | 'SUBSCRIPTION_ACTIVE' | undefined = undefined;
  accountAnonymized = false;
  /** Redis das sessões fora: desativar grava a mudança e responde 503, como o servidor (regra comum 6). */
  revocationDown = false;
  /** Spec 045, E3a: nome, remoção e papéis/estados das pessoas da empresa A (as ações mudam, a tela relê). */
  companyName = 'Padaria Aurora';
  companyRemovedAt: string | null = null;
  /** Spec 045, E5: o canal da empresa A foi desconectado pelo admin. */
  channelDisconnected = false;
  /** A empresa A só tem o número (LEGACY), sem conexão. */
  channelLegacy = false;
  /** O canal está desligado no servidor: desconectar responde 404. */
  channelOff = false;
  readonly people = new Map<string, { role: MembershipRole; status: 'ACTIVE' | 'DISABLED' }>();
  /** Spec 045, E3b: convites pendentes da empresa A (o e-mail só mascarado, como o servidor devolve). */
  readonly invitations: Invitation[] = [fx.pendingInvitation];
  /** Spec 045, E4: a assinatura da conta A (as ações mudam, a tela relê); `null` = sem assinatura. */
  accountSubscription: Subscription | null = { ...fx.accountDetail.subscription! };
  /** Um pedido de pagamento pendente: toda ação da assinatura responde 409 `ORDER_PENDING`. */
  orderPending = false;
  /** Caminhos que passam a responder 401 (sessão vencida no servidor). */
  readonly expired = new Set<string>();
  /** Caminhos que respondem com este status de erro antes de qualquer outra regra (logout com 503...). */
  readonly failures = new Map<string, number>();
  /** Caminhos cuja resposta espera esta promessa (ação "em andamento" pelo tempo que o teste quiser). */
  readonly holds = new Map<string, Promise<void>>();

  constructor(private readonly options: FakeApiOptions) {
    this.signedIn = options.signedIn ?? false;
    for (const person of fx.companyDetail().people)
      this.people.set(person.membershipId, { role: person.role, status: person.status });
  }

  /** O detalhe da empresa A com o estado atual das ações (nome, remoção, papéis e donos). */
  private detailA() {
    const base = fx.companyDetail(this.companyStatus, this.companyRemovedAt);
    const people = base.people.map((person) => ({
      ...person,
      ...this.people.get(person.membershipId),
    }));
    const owners = people.filter(
      (person) =>
        person.role === 'OWNER' &&
        person.status === 'ACTIVE' &&
        (person.account === null || person.account.status === 'ACTIVE'),
    );
    return {
      ...base,
      ...(this.channelLegacy && !this.channelDisconnected
        ? {
            channel: {
              state: 'LEGACY' as const,
              mode: null,
              phoneNumberId: '109876543210',
              wabaId: null,
              connectedAt: null,
              tokenExpiresAt: null,
              tokenInvalidAt: null,
            },
          }
        : {}),
      ...(this.channelDisconnected
        ? {
            channel: {
              state: 'NOT_CONNECTED' as const,
              mode: null,
              phoneNumberId: null,
              wabaId: null,
              connectedAt: null,
              tokenExpiresAt: null,
              tokenInvalidAt: null,
            },
          }
        : {}),
      name: this.companyName,
      people,
      owners: owners.length,
      owner:
        owners[0] === undefined
          ? null
          : { accountId: owners[0].accountId, emailMasked: owners[0].emailMasked },
    };
  }

  callsTo(method: string, path: string): Call[] {
    return this.calls.filter((call) => call.method === method && call.path === path);
  }

  respond(request: Request): { status: number; json?: unknown } {
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, '');
    const method = request.method();
    const headers = request.headers();
    let body: unknown;
    try {
      body = request.postDataJSON();
    } catch {
      body = undefined;
    }
    this.calls.push({ method, path, search: url.searchParams, headers, body });

    const error = (status: number, code: string) => ({
      status,
      json: { error: { code, message: 'texto do servidor que a tela não mostra', requestId: 'r' } },
    });
    if (method === 'POST' && headers['x-soprei-app'] !== 'admin') return error(403, 'FORBIDDEN');
    const failure = this.failures.get(path);
    if (failure !== undefined)
      return error(
        failure,
        failure === 401 ? 'UNAUTHORIZED' : failure === 429 ? 'RATE_LIMITED' : 'SERVICE_UNAVAILABLE',
      );

    if (path === '/platform/auth/login' && method === 'POST') {
      const { email, password, code } = (body ?? {}) as Record<string, unknown>;
      if (email === GOOD.email && password === GOOD.password && code === GOOD.code) {
        this.signedIn = true;
        return { status: 204 };
      }
      return error(401, 'UNAUTHORIZED');
    }
    if (path === '/platform/auth/logout' && method === 'POST') {
      this.signedIn = false;
      return { status: 204 };
    }
    if (!this.signedIn || this.expired.has(path)) {
      this.signedIn = false;
      return error(401, 'UNAUTHORIZED');
    }
    if (path === '/platform/auth/session') return { status: 200, json: { email: fx.ADMIN_EMAIL } };

    const billing = this.options.billingEnabled ?? true;
    if (method === 'GET' && !queryAccepted(path, url.searchParams))
      return error(400, 'VALIDATION_ERROR');
    if (method === 'GET') {
      switch (path) {
        case '/platform/overview':
          return {
            status: 200,
            json: billing ? fx.overview : fx.overviewBillingOff,
          };
        case '/platform/companies': {
          const attention = url.searchParams.get('attention');
          const removed = url.searchParams.get('status') === 'removed';
          const removedA = this.companyRemovedAt !== null;
          const items = removed
            ? removedA
              ? [{ ...fx.companyA, removedAt: this.companyRemovedAt }]
              : []
            : attention === 'token_invalid'
              ? [fx.companyB]
              : attention === null
                ? removedA
                  ? [fx.companyB]
                  : [fx.companyA, fx.companyB]
                : [];
          return {
            status: 200,
            json: {
              items: items.map((c) =>
                c.id === fx.COMPANY_A
                  ? { ...c, status: this.companyStatus, name: this.companyName }
                  : c,
              ),
              nextCursor: null,
            },
          };
        }
        case `/platform/companies/${fx.COMPANY_A}`:
          return { status: 200, json: this.detailA() };
        case `/platform/companies/${fx.COMPANY_A}/invitations`:
          return { status: 200, json: { items: this.invitations, nextCursor: null } };
        case `/platform/companies/${fx.COMPANY_B}/invitations`:
          return { status: 200, json: { items: [], nextCursor: null } };
        case `/platform/companies/${fx.COMPANY_B}`:
          return { status: 200, json: fx.companyDetailB() };
        case '/platform/accounts':
          return { status: 200, json: fx.accountPage };
        case `/platform/accounts/${fx.ACCOUNT_A}`:
          return {
            status: 200,
            json: {
              ...fx.accountDetail,
              subscription: this.accountSubscription,
              status: this.accountStatus,
              verified: this.accountVerified,
              ...(this.accountAnonymized ? { emailMasked: 'r***@excluido.invalid' } : {}),
            },
          };
        case `/platform/accounts/${fx.ACCOUNT_A}/email`:
          return { status: 200, json: fx.accountEmail };
        case '/platform/billing/orders':
          return { status: 200, json: billing ? fx.orderPage : fx.billingOffPage };
        case '/platform/billing/notices':
          return { status: 200, json: billing ? fx.noticePage : fx.billingOffPage };
        case '/platform/health':
          return {
            status: 200,
            json: this.options.queueUnavailable
              ? { ...fx.health, queue: { state: 'unavailable' } }
              : fx.health,
          };
      }
    }
    if (method === 'POST' && path === `/platform/companies/${fx.COMPANY_A}/suspend`) {
      this.companyStatus = 'SUSPENDED';
      return { status: 204 };
    }
    if (method === 'POST' && path === `/platform/companies/${fx.COMPANY_A}/reactivate`) {
      this.companyStatus = 'ACTIVE';
      return { status: 204 };
    }
    if (method === 'POST' && path === '/platform/companies') {
      const parsed = createCompanyBodySchema.safeParse(body);
      if (!parsed.success) return error(400, 'VALIDATION_ERROR');
      if (parsed.data.slug === fx.companyA.slug) return error(409, 'SLUG_TAKEN');
      return {
        status: 201,
        json: { companyId: fx.COMPANY_B, invitation: { ...fx.pendingInvitation, role: 'OWNER' } },
      };
    }
    if (method === 'POST' && path.startsWith(`/platform/companies/${fx.COMPANY_A}/invitations`)) {
      return this.invitationAction(
        path.slice(`/platform/companies/${fx.COMPANY_A}/invitations`.length),
        body,
      );
    }
    if (method === 'POST' && path.startsWith(`/platform/companies/${fx.COMPANY_A}/`)) {
      const action = this.companyAction(
        path.slice(`/platform/companies/${fx.COMPANY_A}/`.length),
        body,
      );
      if (action !== undefined) return action;
    }
    if (method === 'POST' && path.startsWith(`/platform/accounts/${fx.ACCOUNT_A}/`)) {
      return this.accountAction(path.slice(`/platform/accounts/${fx.ACCOUNT_A}/`.length), body);
    }
    return error(404, 'NOT_FOUND');
  }

  /**
   * Ações sobre a empresa A e as pessoas dela (spec 045, E3a), com as regras que a tela percebe: corpo
   * `strict`, código novo (`FRESH_CODE`) nas ações **[código]**, slug digitado, último dono ativo.
   * `undefined` = não é uma ação desta etapa (suspender e reativar seguem acima).
   */
  private companyAction(
    action: string,
    body: unknown,
  ): { status: number; json?: unknown } | undefined {
    const error = (status: number, code: string) => ({
      status,
      json: { error: { code, message: 'texto do servidor que a tela não mostra', requestId: 'r' } },
    });
    const removedOnly = (): boolean => this.companyRemovedAt !== null;
    if (action === 'channel/disconnect') {
      if (this.channelOff) return error(404, 'NOT_FOUND');
      const parsed = confirmedActionBodySchema.safeParse(body);
      if (!parsed.success) return error(400, 'VALIDATION_ERROR');
      if (parsed.data.code !== FRESH_CODE) return error(400, 'CONFIRMATION_INVALID');
      this.channelDisconnected = true;
      return { status: 204 };
    }
    if (action === 'rename') {
      const parsed = renameBodySchema.safeParse(body);
      if (!parsed.success) return error(400, 'VALIDATION_ERROR');
      if (removedOnly()) return error(404, 'NOT_FOUND');
      this.companyName = parsed.data.name;
      return { status: 204 };
    }
    if (action === 'remove') {
      const parsed = removeCompanyBodySchema.safeParse(body);
      if (!parsed.success) return error(400, 'VALIDATION_ERROR');
      if (removedOnly()) return error(404, 'NOT_FOUND');
      if (parsed.data.slug !== fx.companyDetail().slug) return error(400, 'CONFIRMATION_MISMATCH');
      if (parsed.data.code !== FRESH_CODE) return error(400, 'CONFIRMATION_INVALID');
      this.companyRemovedAt = '2026-11-25T15:00:00.000Z';
      return { status: 204 };
    }
    if (action === 'restore') {
      const parsed = confirmedActionBodySchema.safeParse(body);
      if (!parsed.success) return error(400, 'VALIDATION_ERROR');
      if (parsed.data.code !== FRESH_CODE) return error(400, 'CONFIRMATION_INVALID');
      this.companyRemovedAt = null;
      return { status: 204 };
    }
    const match = /^memberships\/([^/]+)\/(role|disable|enable)$/.exec(action);
    if (match === null) return undefined;
    const [, membershipId = '', kind] = match;
    const person = this.people.get(membershipId);
    if (person === undefined || removedOnly()) return error(404, 'NOT_FOUND');
    const activeOwners = this.detailA().owners;
    const isActiveOwner = this.detailA().people.some(
      (p) =>
        p.membershipId === membershipId &&
        p.role === 'OWNER' &&
        p.status === 'ACTIVE' &&
        (p.account === null || p.account.status === 'ACTIVE'),
    );
    if (kind === 'role') {
      const parsed = roleBodySchema.safeParse(body);
      if (!parsed.success) return error(400, 'VALIDATION_ERROR');
      const involvesOwner = person.role === 'OWNER' || parsed.data.role === 'OWNER';
      if (involvesOwner && parsed.data.code !== FRESH_CODE)
        return error(400, 'CONFIRMATION_INVALID');
      if (parsed.data.role !== 'OWNER' && isActiveOwner && activeOwners <= 1)
        return error(409, 'LAST_OWNER');
      person.role = parsed.data.role;
      return this.revocationDown ? error(503, 'SERVICE_UNAVAILABLE') : { status: 204 };
    }
    if (!actionBodySchema.safeParse(body).success) return error(400, 'VALIDATION_ERROR');
    if (kind === 'disable') {
      if (isActiveOwner && activeOwners <= 1) return error(409, 'LAST_OWNER');
      person.status = 'DISABLED';
      return { status: 204 };
    }
    person.status = 'ACTIVE';
    return { status: 204 };
  }

  /** Convites da empresa A (spec 045, E3b): convidar, reenviar e revogar, com corpo `strict`. */
  private invitationAction(rest: string, body: unknown): { status: number; json?: unknown } {
    const error = (status: number, code: string) => ({
      status,
      json: { error: { code, message: 'texto do servidor que a tela não mostra', requestId: 'r' } },
    });
    if (rest === '') {
      const parsed = inviteBodySchema.safeParse(body);
      if (!parsed.success) return error(400, 'VALIDATION_ERROR');
      if (parsed.data.email === fx.MEMBER_EMAIL) return error(409, 'MEMBER_ALREADY_EXISTS');
      const created: Invitation = {
        ...fx.pendingInvitation,
        id: '0193a1b2-0000-7000-8000-0000000000f2',
        emailMasked: `${parsed.data.email.slice(0, 1)}***@${parsed.data.email.split('@')[1] ?? ''}`,
        role: parsed.data.role,
        invitedBy: 'platform',
      };
      this.invitations.push(created);
      return { status: 201, json: created };
    }
    const match = /^\/([^/]+)\/(resend|revoke)$/.exec(rest);
    if (match === null) return error(404, 'NOT_FOUND');
    if (!actionBodySchema.safeParse(body).success) return error(400, 'VALIDATION_ERROR');
    const index = this.invitations.findIndex((item) => item.id === match[1]);
    const invitation = this.invitations[index];
    if (invitation === undefined) return error(404, 'NOT_FOUND');
    if (match[2] === 'revoke') {
      this.invitations.splice(index, 1);
      return { status: 204 };
    }
    const resent = { ...invitation, sendCount: invitation.sendCount + 1 };
    this.invitations[index] = resent;
    return { status: 200, json: resent };
  }

  /** Assinatura da conta A (spec 045, E4), com as regras que a tela percebe e corpo `strict`. */
  private subscriptionAction(action: string, body: unknown): { status: number; json?: unknown } {
    const error = (status: number, code: string) => ({
      status,
      json: { error: { code, message: 'texto do servidor que a tela não mostra', requestId: 'r' } },
    });
    const sub = this.accountSubscription;
    if (action === 'trial') {
      if (!actionBodySchema.safeParse(body).success) return error(400, 'VALIDATION_ERROR');
      if (sub !== null) return error(409, 'SUBSCRIPTION_EXISTS');
      this.accountSubscription = {
        ...fx.accountDetail.subscription!,
        status: 'TRIAL',
        state: 'TRIAL',
        pendingChange: null,
      };
      return { status: 204 };
    }
    if (sub === null) return error(409, 'NO_SUBSCRIPTION');
    const parsers = {
      extend: extendBodySchema,
      modules: modulesBodySchema,
      plan: planBodySchema,
      cancel: actionBodySchema,
      reactivate: actionBodySchema,
      end: confirmedActionBodySchema,
    } as const;
    const parser = parsers[action as keyof typeof parsers] as
      (typeof parsers)[keyof typeof parsers] | undefined;
    if (parser === undefined) return error(404, 'NOT_FOUND');
    const parsed = parser.safeParse(body);
    if (!parsed.success) return error(400, 'VALIDATION_ERROR');
    if (action === 'end' && (parsed.data as Record<string, unknown>).code !== FRESH_CODE)
      return error(400, 'CONFIRMATION_INVALID');
    if (this.orderPending) return error(409, 'ORDER_PENDING');
    const data = parsed.data as Record<string, unknown>;
    switch (action) {
      case 'extend':
        this.accountSubscription = { ...sub, currentPeriodEnd: '2027-01-01T03:00:00.000Z' };
        break;
      case 'modules':
        this.accountSubscription = {
          ...sub,
          modules: { schedule: data.agenda === true, inventory: data.stock === true },
        };
        break;
      case 'plan':
        if (data.planCode === 'ESSENTIAL') return error(409, 'PLAN_DOWNGRADE_BLOCKED');
        this.accountSubscription = {
          ...sub,
          plan: { code: data.planCode as Subscription['plan']['code'], name: 'Escala' },
          pendingChange: null,
        };
        break;
      case 'cancel':
      case 'reactivate':
        this.accountSubscription = { ...sub, cancelAtPeriodEnd: action === 'cancel' };
        break;
      case 'end':
        this.accountSubscription = {
          ...sub,
          status: 'EXPIRED',
          state: 'EXPIRED',
          access: 'blocked',
        };
        break;
    }
    return { status: 204 };
  }

  /** Ações sobre a conta A (spec 045, E2), com as regras que a tela percebe; corpo `strict` como no servidor. */
  private accountAction(action: string, body: unknown): { status: number; json?: unknown } {
    const error = (status: number, code: string) => ({
      status,
      json: { error: { code, message: 'texto do servidor que a tela não mostra', requestId: 'r' } },
    });
    if (action.startsWith('subscription/')) return this.subscriptionAction(action.slice(13), body);
    if (action === 'disable') {
      const parsed = confirmedActionBodySchema.safeParse(body);
      if (!parsed.success) return error(400, 'VALIDATION_ERROR');
      if (parsed.data.code !== FRESH_CODE) return error(400, 'CONFIRMATION_INVALID');
      if (this.options.lastOwner === true) return error(409, 'LAST_OWNER');
      this.accountStatus = 'DISABLED';
      return this.revocationDown ? error(503, 'SERVICE_UNAVAILABLE') : { status: 204 };
    }
    if (action === 'anonymize') {
      const parsed = anonymizeBodySchema.safeParse(body);
      if (!parsed.success) return error(400, 'VALIDATION_ERROR');
      if (parsed.data.code !== FRESH_CODE) return error(400, 'CONFIRMATION_INVALID');
      if (this.anonymizeRefusal !== undefined) return error(409, this.anonymizeRefusal);
      if (this.revocationDown) return error(503, 'SERVICE_UNAVAILABLE');
      this.accountAnonymized = true;
      this.accountStatus = 'DISABLED';
      return { status: 204 };
    }
    if (!actionBodySchema.safeParse(body).success) return error(400, 'VALIDATION_ERROR');
    switch (action) {
      case 'enable':
        this.accountStatus = 'ACTIVE';
        return { status: 204 };
      case 'sessions/revoke':
        return this.revocationDown ? error(503, 'SERVICE_UNAVAILABLE') : { status: 204 };
      case 'password-reset':
        return { status: 202 };
      case 'verification/resend':
        return this.accountVerified ? error(409, 'ALREADY_VERIFIED') : { status: 202 };
    }
    return error(404, 'NOT_FOUND');
  }
}

export async function installFakeApi(page: Page, options: FakeApiOptions = {}): Promise<FakeApi> {
  const api = new FakeApi(options);
  await page.route('**/api/**', async (route) => {
    const hold = api.holds.get(new URL(route.request().url()).pathname.replace(/^\/api/, ''));
    if (hold !== undefined) await hold;
    const { status, json } = api.respond(route.request());
    await route.fulfill(json === undefined ? { status } : { status, json });
  });
  return api;
}

/** Entra pela tela Entrar com as credenciais certas. */
export async function signIn(page: Page): Promise<void> {
  await page.getByLabel('E-mail').fill(GOOD.email);
  await page.getByLabel('Senha').fill(GOOD.password);
  await page.getByLabel('Código do autenticador').fill(GOOD.code);
  await page.getByRole('button', { name: 'Entrar' }).click();
}

/** Nada do admin no armazenamento do navegador. */
export async function storageSizes(page: Page): Promise<[number, number]> {
  return page.evaluate(
    () => [window.localStorage.length, window.sessionStorage.length] as [number, number],
  );
}

/** A página não rola de lado (360 px no celular). */
export async function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
}
