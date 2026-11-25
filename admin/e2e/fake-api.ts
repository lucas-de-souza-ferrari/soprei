import type { Page, Request } from '@playwright/test';
import * as fx from './fixtures';

/**
 * API falsa do admin (spec 044, E3), uma por teste, por `page.route`. Imita as regras da E1 e da E2 que a
 * tela percebe: sessão por cookie (aqui um estado em memória), `X-Soprei-App: admin` exigido em `POST`,
 * 401 uniforme no login, 401 em qualquer rota sem sessão e 400 a parâmetro de consulta desconhecido ou
 * com valor fora da lista (os esquemas `.strict()` de `platform-monitor.validators.ts`).
 */
export const GOOD = { email: fx.ADMIN_EMAIL, password: 'senha-do-dono-bem-longa', code: '123456' };

/** `limit` de 1 a 50 e cursor opaco, como no `pageShape` da E2. */
const PAGE = { limit: /^([1-9]|[1-4][0-9]|50)$/, cursor: /^.{1,512}$/ };

/** Parâmetros aceitos por rota de lista, como nos validadores da E2 (valores em minúsculas). */
const QUERY_RULES: Record<string, Record<string, RegExp>> = {
  '/platform/companies': {
    ...PAGE,
    status: /^(active|suspended)$/,
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
  const rules = QUERY_RULES[path] ?? {};
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
}

export class FakeApi {
  readonly calls: Call[] = [];
  signedIn: boolean;
  companyStatus: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE';
  /** Caminhos que passam a responder 401 (sessão vencida no servidor). */
  readonly expired = new Set<string>();
  /** Caminhos que respondem com este status de erro antes de qualquer outra regra (logout com 503...). */
  readonly failures = new Map<string, number>();
  /** Caminhos cuja resposta espera esta promessa (ação "em andamento" pelo tempo que o teste quiser). */
  readonly holds = new Map<string, Promise<void>>();

  constructor(private readonly options: FakeApiOptions) {
    this.signedIn = options.signedIn ?? false;
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
      return error(failure, failure === 401 ? 'UNAUTHORIZED' : 'SERVICE_UNAVAILABLE');

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
          const items =
            attention === 'token_invalid'
              ? [fx.companyB]
              : attention === null
                ? [fx.companyA, fx.companyB]
                : [];
          return {
            status: 200,
            json: {
              items: items.map((c) =>
                c.id === fx.COMPANY_A ? { ...c, status: this.companyStatus } : c,
              ),
              nextCursor: null,
            },
          };
        }
        case `/platform/companies/${fx.COMPANY_A}`:
          return { status: 200, json: fx.companyDetail(this.companyStatus) };
        case `/platform/companies/${fx.COMPANY_B}`:
          return { status: 200, json: fx.companyDetailB() };
        case '/platform/accounts':
          return { status: 200, json: fx.accountPage };
        case `/platform/accounts/${fx.ACCOUNT_A}`:
          return { status: 200, json: fx.accountDetail };
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
