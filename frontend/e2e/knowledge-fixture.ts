import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { installApi, SENTINEL, type FakeApi } from './company-fixture';

/** Origem do servidor de desenvolvimento dos testes (a mesma do `baseURL`). */
export const SITE_ORIGIN = 'http://127.0.0.1:5186';

/** Estado da API falsa da aba Conhecimento (spec 040): só os documentos e os envios. */
export interface FakeKnowledge {
  posts: { title: string; content: string }[];
  /** Pedidos a host diferente do site (devem ficar vazios). */
  foreign: string[];
  /** Todos os endereços pedidos pela página e pelos workers. */
  requested: string[];
  console: string[];
}

/**
 * Abre `/painel/conhecimento` como OWNER com `knowledge:manage`, a API falsa da área e a da aba.
 * Todo pedido fora de `127.0.0.1:5186` é registrado e abortado.
 */
export async function openKnowledge(
  page: Page,
  theme: 'light' | 'dark' = 'light',
): Promise<{ api: FakeApi; knowledge: FakeKnowledge }> {
  const knowledge: FakeKnowledge = { posts: [], foreign: [], requested: [], console: [] };
  await page.addInitScript((value) => localStorage.setItem('soprei-theme', value), theme);
  page.on('console', (message) => knowledge.console.push(message.text()));
  page.on('pageerror', (error) => knowledge.console.push(String(error)));
  const track = (url: string): void => {
    knowledge.requested.push(url);
    if (
      !url.startsWith(`${SITE_ORIGIN}/`) &&
      !url.startsWith('data:') &&
      !url.startsWith('blob:')
    ) {
      knowledge.foreign.push(url);
    }
  };
  page.context().on('request', (request) => track(request.url()));
  await page.context().route(
    (url) => !url.toString().startsWith(`${SITE_ORIGIN}/`),
    (route) => route.abort(),
  );
  const api = await installApi(page, { role: 'OWNER' });
  const current = api.companies[0];
  if (current === undefined) throw new Error('empresa da fixture');
  current.permissions = [...current.permissions, 'knowledge:manage'];

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api', '');
    const match = /^\/admin\/companies\/([^/]+)\/knowledge\/documents$/.exec(path);
    if (match === null) return route.fallback();
    const reply = (status: number, json?: unknown) =>
      route.fulfill({ status, ...(json === undefined ? {} : { json }) });
    if (match[1] !== api.selected) {
      return reply(404, { error: { code: 'NOT_FOUND', message: SENTINEL, requestId: 'x' } });
    }
    if (request.method() === 'GET') return reply(200, { items: [], nextCursor: null });
    const body = request.postDataJSON() as { title: string; content: string };
    knowledge.posts.push(body);
    return reply(201, {
      id: randomUUID(),
      title: body.title,
      charCount: body.content.length,
      chunkCount: 1,
      preview: body.content.slice(0, 160),
      isSample: false,
      createdAt: new Date().toISOString(),
    });
  });
  await page.goto('/painel/conhecimento');
  return { api, knowledge };
}

/** Segura o primeiro pedido do worker que casa com `pattern` até `release()`. */
async function holdWorker(
  page: Page,
  pattern: RegExp,
): Promise<{ release: () => void; held: () => boolean }> {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let count = 0;
  let held = false;
  await page.route(pattern, async (route) => {
    count++;
    if (count === 1) {
      held = true;
      await gate;
    }
    await route.fallback();
  });
  return { release: () => release(), held: () => held };
}

/** Segura o worker do pdf.js (só o primeiro pedido) até `release()`. */
export const holdPdfWorker = (page: Page) => holdWorker(page, /pdf\.worker/);

/** Segura o worker do leitor de DOCX (só o primeiro pedido) até `release()`. */
export const holdDocxWorker = (page: Page) => holdWorker(page, /docx-text\.worker/);
