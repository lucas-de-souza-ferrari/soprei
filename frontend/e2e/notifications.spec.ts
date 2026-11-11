import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  installApi,
  menuItems,
  PERMISSIONS,
  SENTINEL,
  type FakeApi,
  type Role,
} from './company-fixture';

/**
 * Spec 030: sino, tela de notificações e destaque na conversa. Camada por cima de `installApi`: as rotas
 * de notificação e de conversas desta spec são respondidas aqui (rota registrada depois vale primeiro;
 * `route.fallback()` entrega o resto à API falsa de sempre).
 */

const PHONE = '5511987654321';
const NOTIFICATION_PERMISSIONS: Readonly<Record<Role, readonly string[]>> = {
  OWNER: [...PERMISSIONS.OWNER, 'notification:read', 'notification:resolve'],
  ADMIN: [...PERMISSIONS.ADMIN, 'notification:read', 'notification:resolve'],
  AGENT: [...PERMISSIONS.AGENT, 'notification:read', 'notification:resolve'],
  VIEWER: [...PERMISSIONS.VIEWER, 'notification:read'],
};

interface World {
  readonly api: FakeApi;
  readonly conversationId: string;
  readonly notificationId: string;
  open: boolean;
  resolves: number;
}

async function setup(page: Page, role: Role = 'OWNER'): Promise<World> {
  const api = await installApi(page, { role });
  const current = api.companies[0];
  if (current === undefined) throw new Error('sem empresa');
  current.permissions = NOTIFICATION_PERMISSIONS[role];
  const at = new Date(Date.now() - 5 * 60_000).toISOString();
  const world: World = {
    api,
    conversationId: randomUUID(),
    notificationId: randomUUID(),
    open: true,
    resolves: 0,
  };
  const base = `/api/admin/companies/${current.companyId}`;
  const conversation = {
    id: world.conversationId,
    contactLabel: 'Contato final 4321',
    channel: 'whatsapp' as const,
    createdAt: at,
    updatedAt: at,
  };
  await page.route(`**${base}/**`, async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname;
    if (path === `${base}/notifications/summary`) {
      return route.fulfill({ json: { open: world.open ? 1 : 0 } });
    }
    if (path === `${base}/notifications`) {
      const status = url.searchParams.get('status');
      const item = {
        id: world.notificationId,
        kind: 'HUMAN_HANDOFF',
        reason: 'CONTACT_REQUESTED',
        status: world.open ? 'OPEN' : 'RESOLVED',
        conversation: {
          id: conversation.id,
          contactLabel: conversation.contactLabel,
          channel: 'whatsapp',
        },
        createdAt: at,
        resolvedAt: world.open ? null : new Date().toISOString(),
        resolvedByMe: !world.open,
      };
      const visible = (status === 'open') === world.open;
      return route.fulfill({ json: { items: visible ? [item] : [], nextCursor: null } });
    }
    if (path === `${base}/notifications/${world.notificationId}/resolve` && method === 'POST') {
      if (!NOTIFICATION_PERMISSIONS[role].includes('notification:resolve')) {
        return route.fulfill({
          status: 403,
          json: { error: { code: 'FORBIDDEN', message: SENTINEL, requestId: 'x' } },
        });
      }
      world.open = false;
      world.resolves++;
      return route.fulfill({ status: 204 });
    }
    if (path === `${base}/conversations`) {
      return route.fulfill({
        json: { items: [{ ...conversation, openHandoff: world.open }], nextCursor: null },
      });
    }
    if (path === `${base}/conversations/${conversation.id}/messages`) {
      return route.fulfill({
        json: {
          conversation: {
            ...conversation,
            openHandoff: world.open
              ? { notificationId: world.notificationId, reason: 'CONTACT_REQUESTED', createdAt: at }
              : null,
          },
          items: [],
          nextCursor: null,
        },
      });
    }
    return route.fallback();
  });
  return world;
}

const bell = (page: Page) => page.getByRole('link', { name: /^Notificações/ });

for (const theme of ['light', 'dark'] as const) {
  test(`sino, tela e faixa: abrir a conversa e marcar como resolvido (tema ${theme})`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript((value) => localStorage.setItem('soprei-theme', value), theme);
    const world = await setup(page);
    await page.goto('/painel/conversas');

    // Selo "Humano" na lista e o sino com 1.
    await expect(page.getByTestId('handoff-badge')).toContainText('Humano');
    await expect(bell(page)).toHaveAttribute('aria-label', 'Notificações, 1 aberta');
    await expect(page.getByTestId('notification-badge')).toHaveText('1');
    // A tela de notificações não é item do menu.
    expect(await menuItems(page)).not.toContain('Notificações');

    await bell(page).click();
    await expect(page).toHaveURL(/\/painel\/notificacoes$/);
    const item = page.getByTestId('notification-item');
    await expect(item).toContainText('Atendimento humano solicitado');
    await expect(item).toContainText('Contato final 4321');
    await expect(item).toContainText('O contato pediu para falar com uma pessoa');

    await item.getByRole('link', { name: 'Abrir conversa' }).click();
    await expect(page).toHaveURL(new RegExp(`/painel/conversas/${world.conversationId}$`));
    const banner = page.getByTestId('handoff-banner');
    await expect(banner).toContainText('Esta conversa pediu atendimento humano');
    await page.screenshot({
      path: `test-results/notificacoes-${testInfo.project.name}-${theme}.png`,
      fullPage: true,
    });

    await banner.getByRole('button', { name: 'Marcar como resolvido' }).click();
    await expect(banner).toHaveCount(0);
    expect(world.resolves).toBe(1);
    await expect(bell(page)).toHaveAttribute('aria-label', 'Notificações');
    await expect(page.getByTestId('notification-badge')).toHaveCount(0);

    // Nada de telefone ou texto do servidor na página nem no navegador.
    const text = (await page.locator('body').innerText()) + (await page.content());
    for (const secret of [PHONE, 'contactRef', SENTINEL]) expect(text).not.toContain(secret);
    const stored = await page.evaluate(() => [
      ...Object.keys(localStorage),
      ...Object.keys(sessionStorage),
    ]);
    expect(stored.filter((key) => key !== 'soprei-theme')).toEqual([]);
  });
}

test('tela de notificações: resolver na lista move para Resolvidas', async ({ page }) => {
  await setup(page, 'AGENT');
  await page.goto('/painel/notificacoes');
  const item = page.getByTestId('notification-item');
  await item.getByRole('button', { name: 'Marcar como resolvido' }).click();
  await expect(page.getByText('Nenhum pedido de atendimento humano aberto.')).toBeVisible();
  await page.getByRole('tab', { name: 'Resolvidas' }).click();
  await expect(item).toContainText('Resolvida por você');
  await expect(bell(page)).toHaveAttribute('aria-label', 'Notificações');
});

test('VIEWER vê o sino, a lista e a faixa, sem o botão de resolver', async ({ page }) => {
  const world = await setup(page, 'VIEWER');
  await page.goto('/painel/notificacoes');
  const item = page.getByTestId('notification-item');
  await expect(item).toContainText('Atendimento humano solicitado');
  await expect(item.getByRole('button', { name: 'Marcar como resolvido' })).toHaveCount(0);
  await page.goto(`/painel/conversas/${world.conversationId}`);
  await expect(page.getByTestId('handoff-banner')).toBeVisible();
  await expect(
    page.getByTestId('handoff-banner').getByRole('button', { name: 'Marcar como resolvido' }),
  ).toHaveCount(0);
});

test('sem notification:read não há sino', async ({ page }) => {
  await installApi(page);
  await page.goto('/painel/conversas');
  await expect(page.getByRole('heading', { level: 2, name: 'Conversas' })).toBeVisible();
  await expect(bell(page)).toHaveCount(0);
});
