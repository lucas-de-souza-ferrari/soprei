import { expect, test, type Page } from '@playwright/test';
import { conversation, installApi, message } from './company-fixture';

// Spec 029 (E3): bolhas do beUI no Testar e em Conversas. Contato à esquerda, assistente (o nosso lado) à
// direita; texto sempre puro; nada vaza para console, título, URL ou armazenamento.

const HOSTILE = '<img src=x onerror="window.__pwned=true"> **negrito**\nsegunda linha';
const LONG_URL = `https://exemplo.test/${'a'.repeat(200)}`;
const SECRET = 'SENTINELA-DE-CONTEUDO-123';

async function noHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const element = document.scrollingElement;
    return element !== null && element.scrollWidth <= element.clientWidth;
  });
}

test('Testar: "você" à esquerda e o assistente à direita, texto puro e nome acessível', async ({
  page,
}) => {
  const api = await installApi(page);
  api.reply = { text: `Resposta ${HOSTILE}`, isFallback: false };
  await page.goto('/painel/testar');
  await page.getByLabel('Mensagem de teste').fill(HOSTILE);
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  const log = page.getByRole('log', { name: 'Conversa de teste' });
  await expect(log).toHaveAttribute('aria-live', 'polite');
  const mine = log.getByText('segunda linha').first();
  await expect(mine).toBeVisible();
  // Texto literal: sem elemento criado pela mensagem e sem script executado.
  await expect(log.locator('img, b, strong')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned)).toBe(
    undefined,
  );
  await expect(log.getByText('**negrito**', { exact: false }).first()).toBeVisible();
  await expect(log.locator('[dir="auto"]').first()).toHaveAttribute('dir', 'auto');
  // Quem falou vem em texto para o leitor de tela.
  await expect(log).toContainText('Você:');
  await expect(log).toContainText('Assistente:');
  // Lados: o balão do contato começa à esquerda e o do assistente termina à direita.
  const bubbles = log.locator('[data-slot="message-bubble-content"]');
  await expect(bubbles).toHaveCount(2);
  const box = async (index: number) => {
    const rect = await bubbles.nth(index).boundingBox();
    const area = await log.boundingBox();
    if (rect === null || area === null) throw new Error('sem caixa');
    return { left: rect.x - area.x, right: area.x + area.width - (rect.x + rect.width) };
  };
  const you = await box(0);
  const assistant = await box(1);
  expect(you.left).toBeLessThan(you.right);
  expect(assistant.right).toBeLessThan(assistant.left);
  expect(await noHorizontalScroll(page)).toBe(true);
});

test('360 px: palavra sem espaço quebra dentro da bolha, em Testar e em Conversas', async ({
  page,
}) => {
  const api = await installApi(page);
  const target = conversation('Contato final 1234', 'whatsapp', 1);
  api.conversations = [target];
  api.history = {
    [target.id]: [message('USER', LONG_URL, 3), message('ASSISTANT', LONG_URL, 2)],
  };
  api.reply = { text: LONG_URL, isFallback: false };
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(`/painel/conversas/${target.id}`);
  await expect(page.getByText(LONG_URL, { exact: true }).first()).toBeAttached();
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.goto('/painel/testar');
  await page.getByLabel('Mensagem de teste').fill(LONG_URL);
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect(page.getByRole('log').getByText(LONG_URL, { exact: true })).toHaveCount(2);
  expect(await noHorizontalScroll(page)).toBe(true);
});

test('Conversas: contato à esquerda, assistente à direita; selos preservados', async ({ page }) => {
  const api = await installApi(page);
  const target = conversation('Contato final 1234', 'whatsapp', 1);
  api.conversations = [target];
  api.history = {
    [target.id]: [
      message('USER', 'Oi', 10),
      message('ASSISTANT', 'Resposta padrão', 9, { isFallback: true }),
    ],
  };
  await page.goto(`/painel/conversas/${target.id}`);
  await expect(page.getByText('Resposta padrão: houve falha ao gerar a resposta')).toBeVisible();
  const items = page
    .getByRole('list', { name: /Mensagens/ })
    .locator('[data-slot="message-bubble-content"]');
  await expect(items).toHaveCount(2);
  const first = await items.nth(0).boundingBox();
  const second = await items.nth(1).boundingBox();
  const width = page.viewportSize()?.width ?? 0;
  if (first === null || second === null) throw new Error('sem caixa');
  expect(first.x + first.width / 2).toBeLessThan(second.x + second.width / 2);
  expect(second.x + second.width).toBeGreaterThan(width / 2);
  await expect(page.getByText('Contato', { exact: true })).toBeVisible();
  await expect(page.getByText('Assistente', { exact: true })).toBeVisible();
  await expect(page.locator('time').first()).toBeVisible();
});

test('privacidade: nenhum conteúdo de mensagem em console, título, URL ou armazenamento', async ({
  page,
}) => {
  const logs: string[] = [];
  page.on('console', (entry) => logs.push(entry.text()));
  page.on('pageerror', (error) => logs.push(error.message));
  const api = await installApi(page);
  api.reply = { text: `Resposta ${SECRET}`, isFallback: false };
  await page.goto('/painel/testar');
  await page.getByLabel('Mensagem de teste').fill(`Pergunta ${SECRET}`);
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect(page.getByRole('log').getByText(`Resposta ${SECRET}`)).toBeVisible();
  const stored = await page.evaluate(() => ({
    local: JSON.stringify({ ...localStorage }),
    session: JSON.stringify({ ...sessionStorage }),
    title: document.title,
    href: location.href,
  }));
  for (const value of [...Object.values(stored), ...logs]) expect(value).not.toContain(SECRET);
});
