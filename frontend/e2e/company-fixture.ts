import { expect, type Locator, type Page } from '@playwright/test';
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
  /** Spec 039. */
  mode?: 'API_ONLY' | 'COEXISTENCE' | null;
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

/** Conversa da API falsa (spec 024): só o rótulo mascarado e o canal, como o servidor devolve. */
export interface FakeConversation {
  id: string;
  contactLabel: string;
  channel: 'whatsapp' | 'simulator';
  createdAt: string;
  updatedAt: string;
  /** Spec 039: até quando a IA está pausada; ausente ou `null` = ativa. */
  aiPausedUntil?: string | null;
}

export interface FakeMessage {
  id: string;
  role: 'USER' | 'ASSISTANT' | 'HUMAN';
  content: string;
  isFallback: boolean;
  replyToId: string | null;
  createdAt: string;
  sentAt: string | null;
}

/** Leituras de cada tipo que falham com 500 enquanto a flag estiver ligada (o StrictMode repete efeitos). */
export interface PanelFailures {
  list: boolean;
  more: boolean;
  history: boolean;
  older: boolean;
}

export function conversation(
  label: string,
  channel: 'whatsapp' | 'simulator' = 'whatsapp',
  minutesAgo = 5,
): FakeConversation {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return { id: randomUUID(), contactLabel: label, channel, createdAt: at, updatedAt: at };
}

export function message(
  role: 'USER' | 'ASSISTANT' | 'HUMAN',
  content: string,
  minutesAgo: number,
  extra: Partial<FakeMessage> = {},
): FakeMessage {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return {
    id: randomUUID(),
    role,
    content,
    isFallback: false,
    replyToId: null,
    createdAt: at,
    sentAt: role === 'ASSISTANT' ? at : null,
    ...extra,
  };
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
  setup: {
    embeddedSignup: object | null;
    manualConnect: boolean;
    /** Spec 039: ausente = servidor anterior (sem a escolha). */
    coexistence?: { available: boolean; configId: string | null };
  } | null;
  /** `null` = `GET .../channel` responde 404. */
  channelNotFound: boolean;
  persona: string | null;
  /** Resposta do próximo `embedded-signup`: `ok` ou um erro com `code`. */
  signup: { status: number; code?: string } | 'ok';
  personaStatus: number;
  /** Status do `GET .../persona` (200 = normal). */
  personaLoadStatus: number;
  /** Resposta do simulador. */
  reply: { text: string; isFallback: boolean };
  /** Seleção da sessão depois do primeiro 404 do canal (outra aba trocou a empresa). */
  laterSelected: string | null | undefined;
  /** Conversas da empresa selecionada, da mais recente para a mais antiga (ordem do servidor). */
  conversations: FakeConversation[];
  /** Mensagens por id de conversa, em ordem cronológica. */
  history: Record<string, FakeMessage[]>;
  failures: PanelFailures;
  /** Segura a próxima leitura da lista até `releaseList()`. */
  listGate: Promise<void> | null;
  releaseList: () => void;
  /** Status de erro do `select` (spec 029); `undefined` = 204. */
  selectStatus?: number;
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
    personaLoadStatus: 200,
    reply: { text: 'Olá! Como posso ajudar?', isFallback: false },
    conversations: [],
    history: {},
    failures: { list: false, more: false, history: false, older: false },
    listGate: null,
    releaseList: () => undefined,
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
    if (selecting && state.selectStatus !== undefined) {
      return fail(state.selectStatus, 'INTERNAL_ERROR');
    }
    if (selecting) {
      state.selected = selecting[1] ?? null;
      return reply(204);
    }
    if (path === '/auth/logout') return reply(204);
    // Spec 039: reativar a IA na conversa.
    const resumeRoute = /^\/admin\/companies\/([^/]+)\/conversations\/([^/]+)\/ai\/resume$/.exec(
      path,
    );
    if (resumeRoute !== null && method === 'POST') {
      const [, companyId, conversationId] = resumeRoute;
      if (companyId !== state.selected || current === undefined) return fail(404, 'NOT_FOUND');
      if (!current.permissions.includes('conversation:takeover')) return fail(403, 'FORBIDDEN');
      const found = state.conversations.find((item) => item.id === conversationId);
      if (found === undefined) return fail(404, 'NOT_FOUND');
      found.aiPausedUntil = null;
      return reply(204);
    }
    const panelRoute = /^\/admin\/companies\/([^/]+)\/conversations(?:\/([^/]+)\/messages)?$/.exec(
      path,
    );
    if (panelRoute !== null && method === 'GET') {
      const [, companyId, conversationId] = panelRoute;
      if (companyId !== state.selected || current === undefined) return fail(404, 'NOT_FOUND');
      if (!current.permissions.includes('conversation:read')) return fail(403, 'FORBIDDEN');
      const query = new URL(request.url()).searchParams;
      const offset = query.has('cursor') ? Number(query.get('cursor')) : 0;
      const limit = Number(query.get('limit') ?? 50);
      if (conversationId === undefined) {
        if (state.listGate !== null) await state.listGate;
        const kind = query.has('cursor') ? 'more' : 'list';
        if (state.failures[kind]) return fail(500, 'INTERNAL_ERROR');
        const slice = state.conversations.slice(offset, offset + limit);
        const next = offset + limit < state.conversations.length ? String(offset + limit) : null;
        return reply(200, { items: slice, nextCursor: next });
      }
      const found = state.conversations.find((item) => item.id === conversationId);
      const rows = state.history[conversationId ?? ''];
      if (found === undefined || rows === undefined) return fail(404, 'NOT_FOUND');
      const kind = query.has('cursor') ? 'older' : 'history';
      if (state.failures[kind]) return fail(500, 'INTERNAL_ERROR');
      const ordered = query.get('order') === 'desc' ? [...rows].reverse() : rows;
      const slice = ordered.slice(offset, offset + limit);
      const next = offset + limit < ordered.length ? String(offset + limit) : null;
      return reply(200, { conversation: found, items: slice, nextCursor: next });
    }
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
      const coexistence = (body as { mode?: string } | undefined)?.mode === 'coexistence';
      state.channel = { ...CONNECTED, mode: coexistence ? 'COEXISTENCE' : 'API_ONLY' };
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
      if (method === 'GET') {
        return state.personaLoadStatus === 200
          ? reply(200, { persona: state.persona })
          : fail(state.personaLoadStatus, 'INTERNAL_ERROR');
      }
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
  state.releaseList = () => undefined;
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

/** Segura a próxima leitura da lista de conversas até `releaseList()`. */
export function holdList(state: FakeApi): void {
  state.listGate = new Promise<void>((resolve) => {
    state.releaseList = () => {
      state.listGate = null;
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

/** Spec 039: o evento do fim da coexistência, como o E0 o viu (ids em texto e listas vazias). */
export const coexistenceFinishEvent = (): object => ({
  type: 'WA_EMBEDDED_SIGNUP',
  event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
  data: {
    phone_number_id: PHONE_NUMBER_ID,
    waba_id: WABA_ID,
    business_id: '1',
    page_ids: [],
    catalog_ids: [],
    dataset_ids: [],
    instagram_account_ids: [],
  },
});

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

/**
 * Menu lateral da empresa (spec 029): fixo no computador; no celular abre pelo botão "Abrir menu".
 * Devolve a navegação visível. Chame só com o painel fechado.
 */
export async function openMenu(page: Page): Promise<Locator> {
  const button = page.getByRole('button', { name: 'Abrir menu' });
  const nav = page.getByRole('navigation', { name: 'Menu da empresa' });
  await expect(nav.or(button).first()).toBeVisible();
  // Trocar de empresa remonta o shell (key por empresa): a gaveta antiga pode estar sumindo (ainda
  // visível na animação de saída) ou o clique pode cair no botão que está sendo trocado. Tenta de novo
  // até a navegação ficar visível e estável, em vez de confiar num clique só.
  await expect(async () => {
    if (!(await nav.isVisible())) await button.click({ timeout: 1_000 });
    await expect(nav).toBeVisible({ timeout: 1_000 });
    await page.waitForTimeout(100);
    await expect(nav).toBeVisible({ timeout: 100 });
  }).toPass({ timeout: 10_000 });
  return nav;
}

/** Vai a uma tela pelo menu lateral (abre o painel no celular). */
export async function goTo(page: Page, label: string): Promise<void> {
  const nav = await openMenu(page);
  await nav.getByRole('link', { name: label, exact: true }).click();
}

/** Troca de empresa pelo seletor do menu lateral. */
export async function switchTo(page: Page, name: string): Promise<void> {
  await openMenu(page);
  await page.getByRole('button', { name: /Trocar de empresa/ }).click();
  await page.getByRole('menuitemradio', { name }).click();
}

/** Fecha o painel do menu no celular (no computador não há o que fechar). */
export async function closeMenu(page: Page): Promise<void> {
  const close = page.getByRole('button', { name: 'Fechar menu' });
  if (await close.isVisible()) await close.click();
}

/** Confere os itens do menu (abre e fecha o painel no celular) e devolve o texto da navegação na ordem. */
export async function menuItems(page: Page): Promise<string[]> {
  const nav = await openMenu(page);
  const labels = await nav.getByRole('link').allInnerTexts();
  await closeMenu(page);
  return labels.map((label) => label.trim());
}
