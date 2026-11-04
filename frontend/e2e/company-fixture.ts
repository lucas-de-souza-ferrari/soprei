import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/** Texto que a API falsa põe em toda `message` de erro: nunca pode aparecer na tela. */
export const SENTINEL = 'TEXTO-DO-SERVIDOR-QUE-NAO-PODE-APARECER';
export const APP_ID = '1234567890123';
export const CONFIG_ID = '98765432100123';
export const PHONE_NUMBER_ID = '106540352242922';
export const WABA_ID = '102290129340398';

export const PERMISSIONS = {
  OWNER: [
    'conversation:read',
    'conversation:simulate',
    'membership:read',
    'membership:manage',
    'audit:read',
    'channel:read',
    'channel:manage',
    'persona:manage',
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
  ],
  AGENT: ['conversation:read', 'conversation:simulate'],
  VIEWER: ['conversation:read'],
} as const;
export type Role = keyof typeof PERMISSIONS;

export interface ChannelBody {
  state: 'NOT_CONNECTED' | 'CONNECTED' | 'TOKEN_INVALID' | 'LEGACY';
  phoneNumberId: string | null;
  wabaId: string | null;
  tokenExpiresAt: string | null;
  connectedAt: string | null;
  tokenInvalidAt: string | null;
}

export const NOT_CONNECTED: ChannelBody = {
  state: 'NOT_CONNECTED',
  phoneNumberId: null,
  wabaId: null,
  tokenExpiresAt: null,
  connectedAt: null,
  tokenInvalidAt: null,
};
export const CONNECTED: ChannelBody = {
  state: 'CONNECTED',
  phoneNumberId: PHONE_NUMBER_ID,
  wabaId: WABA_ID,
  tokenExpiresAt: null,
  connectedAt: '2026-11-04T12:00:00.000Z',
  tokenInvalidAt: null,
};

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

export interface FakeCompany {
  companyId: string;
  membershipId: string;
  name: string;
  role: Role;
  permissions: readonly string[];
}

export interface FakeApi {
  role: Role;
  companies: FakeCompany[];
  selected: string | null;
  channel: ChannelBody;
  /** `null` = `GET .../channel/setup` não existe (404). */
  setup: { embeddedSignup: object | null; manualConnect: boolean } | null;
  /** `null` = `GET .../channel` responde 404. */
  channelNotFound: boolean;
  persona: string | null;
  /** Resposta do próximo `embedded-signup`: `ok` ou um erro com `code`. */
  signup: { status: number; code?: string } | 'ok';
  personaStatus: number;
  /** Resposta do simulador. */
  reply: { text: string; isFallback: boolean };
  /** Seleção da sessão depois do primeiro 404 do canal (outra aba trocou a empresa). */
  laterSelected: string | null | undefined;
  /** Segura as respostas do simulador até `release()`. */
  gate: Promise<void> | null;
  calls: Call[];
  external: string[];
  release: () => void;
}

const FAKE_SDK = `
window.__fb = { inits: [], logins: [], cb: null };
window.FB = {
  init: function (options) { window.__fb.inits.push(options); },
  login: function (callback, options) {
    window.__fb.logins.push(JSON.parse(JSON.stringify(options)));
    window.__fb.cb = callback;
    window.open('about:blank', 'fbpopup', 'width=10,height=10');
  }
};
if (window.fbAsyncInit) window.fbAsyncInit();
`;

export function company(name: string, role: Role = 'OWNER'): FakeCompany {
  return {
    companyId: randomUUID(),
    membershipId: randomUUID(),
    name,
    role,
    permissions: PERMISSIONS[role],
  };
}

/** Instala a API falsa (`/api/**`) e o SDK falso da Meta na página. Nada sai para a internet. */
export async function installApi(page: Page, overrides: Partial<FakeApi> = {}): Promise<FakeApi> {
  const first = company('Empresa A', overrides.role ?? 'OWNER');
  const state: FakeApi = {
    role: 'OWNER',
    companies: [first],
    selected: first.companyId,
    channel: NOT_CONNECTED,
    setup: {
      embeddedSignup: { appId: APP_ID, configId: CONFIG_ID, graphApiVersion: 'v26.0' },
      manualConnect: false,
    },
    channelNotFound: false,
    persona: null,
    signup: 'ok',
    personaStatus: 200,
    reply: { text: 'Olá! Como posso ajudar?', isFallback: false },
    gate: null,
    laterSelected: undefined,
    calls: [],
    external: [],
    release: () => undefined,
    ...overrides,
  };
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')
      state.external.push(request.url());
  });
  await page.addInitScript(() => {
    // O popup do SDK falso: um objeto qualquer (o site só confere se `window.open` devolveu `null`).
    window.open = () => ({ closed: false }) as unknown as Window;
  });
  await page.route('https://**/*', (route) => route.abort());
  await page.route('https://connect.facebook.net/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_SDK }),
  );
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api', '');
    const method = request.method();
    const body: unknown = method === 'GET' ? undefined : (request.postDataJSON() as unknown);
    state.calls.push({ method, path, body });
    const reply = (status: number, json?: unknown) =>
      route.fulfill({ status, ...(json === undefined ? {} : { json }) });
    const fail = (status: number, code: string) =>
      reply(status, { error: { code, message: SENTINEL, requestId: 'x' } });
    const current = state.companies.find((item) => item.companyId === state.selected);
    const channelRoute =
      /^\/admin\/companies\/([^/]+)\/(channel(?:\/setup|\/embedded-signup)?|persona|messages)$/.exec(
        path,
      );

    if (path === '/auth/session') {
      return reply(200, {
        id: randomUUID(),
        email: 'pessoa@example.test',
        selectedCompanyId: state.selected,
      });
    }
    if (path === '/account/companies' && method === 'GET') {
      return reply(200, { items: state.companies });
    }
    const selecting = /^\/account\/companies\/([^/]+)\/select$/.exec(path);
    if (selecting) {
      state.selected = selecting[1] ?? null;
      return reply(204);
    }
    if (path === '/auth/logout') return reply(204);
    if (channelRoute === null) return fail(404, 'NOT_FOUND');

    const [, id, rest] = channelRoute;
    if (id !== state.selected || current === undefined) return fail(404, 'NOT_FOUND');
    const allowed = (permission: string): boolean => current.permissions.includes(permission);
    if (rest === 'channel' && method === 'GET') {
      if (state.channelNotFound) {
        // Depois do 404 a seleção da sessão muda (outra aba escolheu outra empresa).
        if (state.laterSelected !== undefined) state.selected = state.laterSelected;
        return fail(404, 'NOT_FOUND');
      }
      return allowed('channel:read') ? reply(200, state.channel) : fail(403, 'FORBIDDEN');
    }
    if (rest === 'channel/setup') {
      if (state.setup === null) return fail(404, 'NOT_FOUND');
      return allowed('channel:manage') ? reply(200, state.setup) : fail(403, 'FORBIDDEN');
    }
    if (rest === 'channel/embedded-signup') {
      if (state.signup !== 'ok')
        return fail(state.signup.status, state.signup.code ?? 'VALIDATION_ERROR');
      state.channel = CONNECTED;
      return reply(200, state.channel);
    }
    if (rest === 'channel' && method === 'PUT') {
      state.channel = CONNECTED;
      return reply(200, state.channel);
    }
    if (rest === 'channel' && method === 'DELETE') {
      state.channel = NOT_CONNECTED;
      return reply(204);
    }
    if (rest === 'persona') {
      if (!allowed('persona:manage')) return fail(403, 'FORBIDDEN');
      if (method === 'GET') return reply(200, { persona: state.persona });
      if (state.personaStatus !== 200) return fail(state.personaStatus, 'VALIDATION_ERROR');
      state.persona = (body as { persona: string | null }).persona;
      return reply(200, { persona: state.persona });
    }
    if (rest === 'messages') {
      if (state.gate !== null) await state.gate;
      return reply(201, {
        conversationId: randomUUID(),
        messageId: randomUUID(),
        reply: state.reply,
        duplicate: false,
      });
    }
    return fail(404, 'NOT_FOUND');
  });
  state.release = () => undefined;
  return state;
}

/** Cria uma porta: o simulador só responde depois de `release()`. */
export function hold(state: FakeApi): void {
  state.gate = new Promise<void>((resolve) => {
    state.release = () => {
      state.gate = null;
      resolve();
    };
  });
}

/** Entrega ao site um evento `message` com a origem escolhida (o `postMessage` real teria a do popup). */
export async function postFromPopup(page: Page, origin: string, data: unknown): Promise<void> {
  await page.evaluate(
    ([value, text]) => {
      window.dispatchEvent(new MessageEvent('message', { data: text, origin: value }));
    },
    [origin, typeof data === 'string' ? data : JSON.stringify(data)] as const,
  );
}

export const finishEvent = (): object => ({
  type: 'WA_EMBEDDED_SIGNUP',
  event: 'FINISH',
  data: { phone_number_id: PHONE_NUMBER_ID, waba_id: WABA_ID, business_id: '1' },
});

export async function answerLogin(page: Page, code: string | null): Promise<void> {
  await page.evaluate((value) => {
    (window as unknown as { __fb: { cb: (r: object) => void } }).__fb.cb(
      value === null ? { authResponse: null } : { authResponse: { code: value } },
    );
  }, code);
}
