import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { company, installApi, SENTINEL, type Call, type FakeApi } from './company-fixture';

/**
 * API falsa do assistente de primeiros passos (spec 030): camada por cima da API falsa da área da empresa
 * (`page.route` registrado depois vale primeiro; o resto segue por `route.fallback()`). O estado (documentos,
 * produtos, serviços, "dispensado") vive aqui; a persona é a da API base. Nada sai para a internet.
 */
export type OnboardingRole = 'OWNER' | 'ADMIN' | 'AGENT' | 'VIEWER';

const ADMIN_PERMISSIONS = [
  'conversation:read',
  'conversation:simulate',
  'membership:read',
  'membership:manage',
  'channel:read',
  'channel:manage',
  'persona:manage',
  'knowledge:manage',
  'inventory:manage',
  'schedule:read',
  'schedule:manage',
  'schedule:configure',
  'onboarding:manage',
] as const;

export const ONBOARDING_PERMISSIONS: Readonly<Record<OnboardingRole, readonly string[]>> = {
  OWNER: ADMIN_PERMISSIONS,
  ADMIN: ADMIN_PERMISSIONS,
  AGENT: ['conversation:read', 'conversation:simulate', 'schedule:read', 'schedule:manage'],
  VIEWER: ['conversation:read', 'schedule:read'],
};

interface FakeDoc {
  id: string;
  title: string;
  isSample: boolean;
}
interface FakeProduct {
  id: string;
  sku: string;
  name: string;
  isSample: boolean;
  active: boolean;
}
interface FakeService {
  id: string;
  name: string;
  isSample: boolean;
  active: boolean;
}

export interface FakeOnboarding {
  dismissed: boolean;
  docs: FakeDoc[];
  products: FakeProduct[];
  services: FakeService[];
  /** Todas as chamadas às rotas desta camada (inclui as de leitura). */
  calls: Call[];
  /** Leituras de `GET .../onboarding` que falham com 500 enquanto a flag estiver ligada. */
  failState: boolean;
  /** Fontes devolvidas pelo simulador. */
  sources: { kind: 'document' | 'product' | 'schedule'; label: string }[];
  /** Status do próximo `PUT .../onboarding` (200 = normal). */
  dismissStatus: number;
}

export function newOnboarding(): FakeOnboarding {
  return {
    dismissed: false,
    docs: [],
    products: [],
    services: [],
    calls: [],
    failState: false,
    sources: [],
    dismissStatus: 200,
  };
}

/** Escritas vistas pela API falsa (tudo que não é GET), útil para provar que "pular" não grava nada. */
export function writes(api: FakeApi, onb: FakeOnboarding): Call[] {
  return [...api.calls, ...onb.calls].filter(
    (call) =>
      call.method !== 'GET' &&
      !call.path.endsWith('/select') &&
      call.path !== '/auth/logout' &&
      call.path !== '/account/companies',
  );
}

function docItem(doc: FakeDoc): object {
  return {
    id: doc.id,
    title: doc.title,
    charCount: 120,
    chunkCount: 1,
    preview: 'Prévia do documento.',
    isSample: doc.isSample,
    createdAt: new Date().toISOString(),
  };
}

function productItem(product: FakeProduct): object {
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    description: '',
    priceCents: 5990,
    quantity: 10,
    lowStockThreshold: 0,
    active: product.active,
    isSample: product.isSample,
    updatedAt: new Date().toISOString(),
  };
}

export async function installOnboardingApi(
  page: Page,
  api: FakeApi,
  onb: FakeOnboarding,
  role: OnboardingRole = 'OWNER',
): Promise<void> {
  for (const item of api.companies) item.permissions = ONBOARDING_PERMISSIONS[role];
  const permissionsOf = (): readonly string[] =>
    api.companies.find((item) => item.companyId === api.selected)?.permissions ?? [];
  const has = (permission: string): boolean => permissionsOf().includes(permission);

  // Criar empresa (conta nova sem empresa): a base não trata `POST /account/companies`.
  await page.route('**/api/account/companies', async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.fallback();
    const body = request.postDataJSON() as { name: string };
    api.calls.push({ method: 'POST', path: '/account/companies', body });
    const created = company(body.name, role === 'AGENT' || role === 'VIEWER' ? role : 'OWNER');
    created.permissions = ONBOARDING_PERMISSIONS[role === 'ADMIN' ? 'OWNER' : role];
    api.companies.push(created);
    return route.fulfill({ status: 201, json: created });
  });

  await page.route('**/api/admin/companies/*/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, '');
    const match = /^\/admin\/companies\/([^/]+)\/(.*)$/.exec(path);
    const method = request.method();
    if (match === null) return route.fallback();
    const [, companyId, rest = ''] = match;
    const relevant =
      rest === 'onboarding' ||
      rest.startsWith('knowledge/') ||
      rest.startsWith('inventory/') ||
      rest.startsWith('schedule/') ||
      rest === 'messages';
    if (!relevant) return route.fallback();
    const body: unknown = method === 'GET' ? undefined : (request.postDataJSON() as unknown);
    onb.calls.push({ method, path, body });
    const reply = (status: number, json?: unknown) =>
      route.fulfill({ status, ...(json === undefined ? {} : { json }) });
    const fail = (status: number, code: string) =>
      reply(status, { error: { code, message: SENTINEL, requestId: 'x' } });
    if (companyId !== api.selected) return fail(404, 'NOT_FOUND');

    const state = (): object => {
      const steps: Record<string, boolean> = {};
      if (has('persona:manage')) steps.persona = api.persona !== null;
      if (has('knowledge:manage')) steps.knowledge = onb.docs.length > 0;
      if (has('schedule:configure')) steps.schedule = onb.services.some((item) => item.active);
      if (has('inventory:manage')) steps.inventory = onb.products.some((item) => item.active);
      return { dismissed: onb.dismissed, steps };
    };

    if (rest === 'onboarding') {
      if (!has('onboarding:manage')) return fail(403, 'FORBIDDEN');
      if (method === 'GET') {
        if (onb.failState) return fail(500, 'INTERNAL_ERROR');
        return reply(200, state());
      }
      if (onb.dismissStatus !== 200) return fail(onb.dismissStatus, 'INTERNAL_ERROR');
      onb.dismissed = (body as { dismissed: boolean }).dismissed;
      return reply(200, state());
    }
    if (rest === 'messages') {
      if (!has('conversation:simulate')) return fail(403, 'FORBIDDEN');
      return reply(201, {
        conversationId: randomUUID(),
        messageId: randomUUID(),
        reply: api.reply,
        sources: onb.sources,
        duplicate: false,
      });
    }
    if (rest === 'knowledge/documents') {
      if (!has('knowledge:manage')) return fail(403, 'FORBIDDEN');
      if (method === 'GET') return reply(200, { items: onb.docs.map(docItem), nextCursor: null });
      const input = body as { title: string };
      const doc = { id: randomUUID(), title: input.title, isSample: false };
      onb.docs.unshift(doc);
      return reply(201, docItem(doc));
    }
    if (rest === 'knowledge/sample') {
      if (!has('knowledge:manage') || !has('inventory:manage')) return fail(403, 'FORBIDDEN');
      if (method === 'POST') {
        if (onb.docs.length > 0 || onb.products.length > 0) {
          return fail(409, 'SAMPLE_REQUIRES_EMPTY');
        }
        onb.docs.push(
          { id: randomUUID(), title: 'Política de trocas (exemplo)', isSample: true },
          { id: randomUUID(), title: 'Horários (exemplo)', isSample: true },
        );
        for (let index = 1; index <= 8; index += 1) {
          onb.products.push({
            id: randomUUID(),
            sku: `EX-${String(index)}`,
            name: `Produto de exemplo ${String(index)}`,
            isSample: true,
            active: true,
          });
        }
        return reply(201, { created: true });
      }
      const removed = { documents: onb.docs.filter((d) => d.isSample).length, products: 8 };
      onb.docs = onb.docs.filter((d) => !d.isSample);
      for (const product of onb.products) if (product.isSample) product.active = false;
      return reply(200, removed);
    }
    if (rest === 'inventory/products') {
      if (!has('inventory:manage')) return fail(403, 'FORBIDDEN');
      if (method === 'GET') {
        return reply(200, { items: onb.products.map(productItem), nextCursor: null });
      }
      const input = body as { sku: string; name: string };
      const product = {
        id: randomUUID(),
        sku: input.sku,
        name: input.name,
        isSample: false,
        active: true,
      };
      onb.products.push(product);
      return reply(201, productItem(product));
    }
    if (rest === 'inventory/products/import') {
      if (!has('inventory:manage')) return fail(403, 'FORBIDDEN');
      const rows = (body as { rows?: { sku: string; name: string }[] }).rows ?? [];
      for (const row of rows) {
        onb.products.push({
          id: randomUUID(),
          sku: row.sku,
          name: row.name,
          isSample: false,
          active: true,
        });
      }
      return reply(200, { created: rows.length, skipped: [] });
    }
    if (rest === 'schedule/services') {
      if (!has('schedule:read')) return fail(403, 'FORBIDDEN');
      if (method === 'GET') {
        return reply(200, {
          items: onb.services.map((item) => ({
            id: item.id,
            name: item.name,
            durationMinutes: 30,
            bufferMinutes: 0,
            active: item.active,
            isSample: item.isSample,
          })),
        });
      }
      const input = body as { name: string };
      const service = { id: randomUUID(), name: input.name, isSample: false, active: true };
      onb.services.push(service);
      return reply(201, {
        id: service.id,
        name: service.name,
        durationMinutes: 30,
        bufferMinutes: 0,
        active: true,
        isSample: false,
      });
    }
    if (rest === 'schedule/sample') {
      if (!has('schedule:configure')) return fail(403, 'FORBIDDEN');
      if (method === 'POST') {
        if (onb.services.some((item) => !item.isSample)) return fail(409, 'SAMPLE_REQUIRES_EMPTY');
        onb.services = [
          { id: randomUUID(), name: 'Corte de cabelo (exemplo)', isSample: true, active: true },
        ];
        return reply(201, { created: true });
      }
      onb.services = onb.services.map((item) => ({ ...item, active: false }));
      return reply(200, { services: 1 });
    }
    return route.fallback();
  });
}

/** Abre o painel com a API falsa do assistente já instalada. */
export async function openWizard(
  page: Page,
  options: {
    role?: OnboardingRole;
    theme?: 'light' | 'dark';
    path?: string;
    seed?: (api: FakeApi, onb: FakeOnboarding) => void;
    api?: Partial<FakeApi>;
  } = {},
): Promise<{ api: FakeApi; onb: FakeOnboarding }> {
  const role = options.role ?? 'OWNER';
  await page.addInitScript(
    (value) => localStorage.setItem('soprei-theme', value),
    options.theme ?? 'light',
  );
  const api = await installApi(page, { role: role === 'ADMIN' ? 'OWNER' : role, ...options.api });
  const onb = newOnboarding();
  options.seed?.(api, onb);
  await installOnboardingApi(page, api, onb, role);
  await page.goto(options.path ?? '/painel/primeiros-passos');
  return { api, onb };
}

export async function noHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}
