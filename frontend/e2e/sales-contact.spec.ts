import { expect, test, type Page } from '@playwright/test';
import { installBillingApi, newBilling } from './billing-fixture';
import { installApi, SENTINEL } from './company-fixture';

// Spec 040 (E4): formulário de contato comercial (página pública /fale-conosco e cartão Enterprise da
// Assinatura). API falsa por `page.route`; nada sai para a internet nem envia e-mail.

interface ContactApi {
  /** `at`: instante (relógio do Node) em que a rota falsa recebeu o pedido. */
  readonly calls: { method: string; path: string; body: unknown; at: number }[];
  /** Resposta do próximo POST: status e, no erro, o `error.code`. */
  next: { status: number; code?: string };
}

// O site mostra sempre a frase fixa; a rota falsa responde outro texto para provar que ele não é lido.
const ACCEPTED = 'Recebemos o seu contato. Responderemos pelo e-mail informado.';

// Os envios esperam o token ter 3,5 s antes do POST (o servidor descarta o de menos de 3 s).
test.describe.configure({ timeout: 60_000 });
const SEND = { timeout: 10_000 };

async function installContactApi(page: Page): Promise<ContactApi> {
  const state: ContactApi = { calls: [], next: { status: 202 } };
  let tokens = 0;
  await page.route('**/api/contact/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api', '');
    const method = request.method();
    state.calls.push({
      method,
      path,
      body: method === 'GET' ? undefined : request.postDataJSON(),
      at: Date.now(),
    });
    if (method === 'GET' && path === '/contact/sales/form-token') {
      tokens += 1;
      return route.fulfill({
        status: 200,
        json: { formToken: `1700000000000.token-${String(tokens)}` },
      });
    }
    if (method === 'POST' && path === '/contact/sales') {
      const headers = request.headers();
      if (headers['x-soprei-app'] !== 'web')
        return route.fulfill({
          status: 403,
          json: { error: { code: 'FORBIDDEN', message: SENTINEL } },
        });
      const { status, code } = state.next;
      if (status === 202) return route.fulfill({ status: 202, json: { message: SENTINEL } });
      return route.fulfill({
        status,
        json: { error: { code: code ?? 'X', message: SENTINEL, requestId: 'r' } },
      });
    }
    return route.fulfill({
      status: 404,
      json: { error: { code: 'NOT_FOUND', message: SENTINEL } },
    });
  });
  return state;
}

async function openContactPage(
  page: Page,
  theme: 'light' | 'dark' = 'light',
): Promise<{ api: ContactApi; sessionCalls: string[] }> {
  await page.addInitScript((value) => localStorage.setItem('soprei-theme', value), theme);
  await page.route('https://**/*', (route) => route.abort());
  const sessionCalls: string[] = [];
  await page.route('**/api/**', (route) => {
    sessionCalls.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 401, json: { error: { code: 'UNAUTHORIZED' } } });
  });
  const api = await installContactApi(page);
  await page.goto('/fale-conosco');
  return { api, sessionCalls };
}

const FILLED = {
  name: 'Maria Souza',
  email: 'maria@empresa.test',
  phone: '+55 (11) 98888-7777',
  company: 'Rede Exemplo',
  message: 'Queremos uma proposta para 40 lojas.',
};

async function fill(page: Page): Promise<void> {
  await page.getByLabel('Seu nome').fill(FILLED.name);
  await page.getByLabel('E-mail').fill(FILLED.email);
  await page.getByLabel('Telefone ou WhatsApp (opcional)').fill(FILLED.phone);
  await page.getByLabel('Nome da empresa').fill(FILLED.company);
  await page.getByLabel('Quantas empresas ou unidades?').selectOption('31-100');
  await page.getByLabel('Volume estimado de mensagens').selectOption('nao-sei');
  await page.getByLabel('Mensagem').fill(FILLED.message);
  await page.getByRole('checkbox', { name: /Li a Política de Privacidade/ }).check();
}

async function assertNothingStored(page: Page): Promise<void> {
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual(['soprei-theme']);
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
  expect(page.url()).not.toContain('?');
  expect(page.url()).not.toContain('#');
  const title = await page.title();
  for (const value of Object.values(FILLED)) {
    expect(page.url()).not.toContain(encodeURIComponent(value));
    expect(title).not.toContain(value);
  }
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

for (const theme of ['light', 'dark'] as const) {
  test(`/fale-conosco sem sessão: envia, mostra a mensagem do servidor e limpa o formulário (tema ${theme})`, async ({
    page,
  }) => {
    const { api, sessionCalls } = await openContactPage(page, theme);
    await expect(page.getByRole('heading', { level: 1, name: 'Fale com a gente' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(
      theme === 'dark',
    );
    await expect(page.getByRole('button', { name: 'Enviar' })).toBeEnabled();
    await fill(page);
    const tokenCalls = () =>
      api.calls.filter((call) => call.path === '/contact/sales/form-token').length;
    const issued = tokenCalls();
    await page.getByRole('button', { name: 'Enviar' }).click();
    await expect(page.getByTestId('contato-enviado')).toHaveText(ACCEPTED, SEND);
    await expect(page.getByText(SENTINEL)).toHaveCount(0);
    // Formulário limpo.
    await expect(page.getByLabel('Seu nome')).toHaveValue('');
    await expect(page.getByLabel('Mensagem')).toHaveValue('');
    await expect(
      page.getByRole('checkbox', { name: /Li a Política de Privacidade/ }),
    ).not.toBeChecked();
    const posts = api.calls.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({
      name: FILLED.name,
      email: FILLED.email,
      phone: FILLED.phone,
      companyName: FILLED.company,
      units: '31-100',
      monthlyVolume: 'nao-sei',
      message: FILLED.message,
      privacyAck: true,
      website: '',
      // O último token emitido antes do envio (o StrictMode do desenvolvimento pede duas vezes ao montar).
      formToken: `1700000000000.token-${String(issued)}`,
    });
    // Um token novo é pedido depois do envio; a sessão nunca é lida.
    await expect.poll(tokenCalls).toBe(issued + 1);
    expect(sessionCalls).toEqual([]);
    await assertNothingStored(page);
  });

  test(`/fale-conosco a 360 px sem rolagem horizontal (tema ${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await openContactPage(page, theme);
    await expect(page.getByRole('heading', { level: 1, name: 'Fale com a gente' })).toBeVisible();
    await noHorizontalScroll(page);
    await page.getByRole('button', { name: 'Enviar' }).click();
    await expect(page.getByText('Informe o seu nome (de 2 a 100 caracteres).')).toBeVisible();
    await noHorizontalScroll(page);
  });
}

test('campos inválidos: nada é enviado e o foco vai ao primeiro campo com erro', async ({
  page,
}) => {
  const { api } = await openContactPage(page);
  await expect(page.getByRole('button', { name: 'Enviar' })).toBeEnabled();
  await page.getByRole('button', { name: 'Enviar' }).click();
  await expect(page.getByLabel('Seu nome')).toBeFocused();
  await expect(page.getByText('Confirme que leu a Política de Privacidade.')).toBeVisible();
  await page.getByLabel('Seu nome').fill(FILLED.name);
  await page.getByRole('button', { name: 'Enviar' }).click();
  await expect(page.getByLabel('E-mail')).toBeFocused();
  expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
});

test('o honeypot não é focável nem lido pelo leitor de tela', async ({ page }) => {
  await openContactPage(page);
  await expect(page.getByRole('button', { name: 'Enviar' })).toBeEnabled();
  await expect(page.getByRole('textbox', { name: 'Site' })).toHaveCount(0);
  const honeypot = page.locator('input[name="website"]');
  await expect(honeypot).toHaveAttribute('tabindex', '-1');
  await expect(honeypot).toHaveAttribute('autocomplete', 'off');
  // Percorre a página toda com Tab: o foco nunca cai no honeypot.
  await page.getByLabel('Seu nome').focus();
  for (let i = 0; i < 20; i += 1) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('name'))).not.toBe(
      'website',
    );
  }
  const snapshot = await page.locator('form').ariaSnapshot();
  expect(snapshot).not.toContain('Site');
});

test('o link da ciência abre /privacidade', async ({ page, context }) => {
  await openContactPage(page);
  const link = page.getByRole('link', { name: 'Política de Privacidade' }).first();
  await expect(link).toHaveAttribute('href', '/privacidade');
  const [popup] = await Promise.all([context.waitForEvent('page'), link.click()]);
  await popup.waitForLoadState();
  expect(new URL(popup.url()).pathname).toBe('/privacidade');
  await expect(
    popup.getByRole('heading', { level: 1, name: 'Política de Privacidade do Soprei' }),
  ).toBeVisible();
});

test('erros escolhidos por status e error.code, nunca pelo texto do servidor', async ({ page }) => {
  const { api } = await openContactPage(page);
  const cases: { status: number; code?: string; text: RegExp }[] = [
    { status: 400, code: 'FORM_EXPIRED', text: /aberto por muito tempo/ },
    { status: 429, code: 'RATE_LIMITED', text: /Muitos envios em pouco tempo/ },
    { status: 503, code: 'SERVICE_UNAVAILABLE', text: /Tente de novo em alguns minutos/ },
    { status: 403, code: 'FORBIDDEN', text: /Recarregue e tente de novo/ },
  ];
  for (const item of cases) {
    api.next = { status: item.status, ...(item.code === undefined ? {} : { code: item.code }) };
    await expect(page.getByRole('button', { name: 'Enviar' })).toBeEnabled();
    await fill(page);
    await page.getByRole('button', { name: 'Enviar' }).click();
    await expect(page.getByRole('alert').filter({ hasText: item.text })).toBeVisible(SEND);
    await expect(page.getByText(SENTINEL)).toHaveCount(0);
    // O rascunho continua (só o envio aceito limpa).
    await expect(page.getByLabel('Seu nome')).toHaveValue(FILLED.name);
  }
  await assertNothingStored(page);
});

test('página inicial: "Fale com a gente" no menu e no rodapé leva a /fale-conosco', async ({
  page,
}, testInfo) => {
  await page.route('https://**/*', (route) => route.abort());
  await installContactApi(page);
  await page.goto('/');
  const links = page.locator('a[href="/fale-conosco"]');
  await expect(links).toHaveCount(2);
  // No celular o menu do topo fica escondido (como os outros itens dele); o rodapé vale nos dois.
  if (testInfo.project.name === 'desktop')
    await expect(
      page.getByRole('navigation', { name: 'Navegação principal' }).getByRole('link', {
        name: 'Fale com a gente',
      }),
    ).toHaveCount(1);
  await page.locator('footer').getByRole('link', { name: 'Fale com a gente' }).click();
  await expect(page).toHaveURL(/\/fale-conosco$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Fale com a gente' })).toBeVisible();
});

for (const checkoutEnabled of [true, false]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`Assinatura > Planos: cartão Enterprise não selecionável; "Falar com a gente" abre o Modal com foco no primeiro campo e Esc fecha (checkout ${checkoutEnabled ? 'ligado' : 'desligado'}, tema ${theme})`, async ({
      page,
    }) => {
      await page.addInitScript((value) => localStorage.setItem('soprei-theme', value), theme);
      const api = await installApi(page, { role: 'OWNER' });
      await installBillingApi(page, api, newBilling({ checkoutEnabled }));
      const contact = await installContactApi(page);
      await page.goto('/painel/assinatura');
      await page.getByRole('tab', { name: 'Planos' }).click();
      const card = page.getByTestId('cartao-enterprise');
      await expect(card).toBeVisible();
      await expect(card).toContainText('Enterprise');
      await expect(card).toContainText('Sob consulta');
      await expect(card.getByRole('radio')).toHaveCount(0);
      await expect(card).not.toContainText('R$');
      await noHorizontalScroll(page);

      await card.getByRole('button', { name: 'Falar com a gente' }).click();
      const dialog = page.getByRole('dialog', { name: 'Falar com a gente' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel('Seu nome')).toBeFocused();
      await noHorizontalScroll(page);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(card.getByRole('button', { name: 'Falar com a gente' })).toBeFocused();

      // De novo, agora enviando: o formulário é o mesmo da página pública.
      await card.getByRole('button', { name: 'Falar com a gente' }).click();
      await expect(dialog.getByRole('button', { name: 'Enviar' })).toBeEnabled();
      await fill(page);
      await dialog.getByRole('button', { name: 'Enviar' }).click();
      await expect(dialog.getByTestId('contato-enviado')).toHaveText(ACCEPTED, SEND);
      expect(contact.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
      expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
      expect(await page.evaluate(() => Object.keys(localStorage))).toEqual(['soprei-theme']);
    });
  }
}

test('Assinatura a 360 px com o Modal do contato aberto: sem rolagem horizontal', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const api = await installApi(page, { role: 'OWNER' });
  await installBillingApi(page, api, newBilling());
  await installContactApi(page);
  await page.goto('/painel/assinatura');
  await page.getByRole('tab', { name: 'Planos' }).click();
  await page
    .getByTestId('cartao-enterprise')
    .getByRole('button', { name: 'Falar com a gente' })
    .click();
  await expect(page.getByRole('dialog', { name: 'Falar com a gente' })).toBeVisible();
  await noHorizontalScroll(page);
});

/** Intervalo entre o último GET do token antes do POST e o POST, pela rota falsa. */
function tokenAgeAtPost(api: ContactApi, postIndex: number): number {
  const posts = api.calls.filter((call) => call.method === 'POST');
  const post = posts[postIndex];
  if (post === undefined) throw new Error('POST não encontrado');
  const tokens = api.calls.filter(
    (call) => call.path === '/contact/sales/form-token' && call.at <= post.at,
  );
  const last = tokens.at(-1);
  if (last === undefined) throw new Error('token não encontrado');
  return post.at - last.at;
}

test('depois de FORM_EXPIRED, o reenvio imediato espera o tempo mínimo e o pedido chega', async ({
  page,
}) => {
  const { api } = await openContactPage(page);
  await expect(page.getByRole('button', { name: 'Enviar' })).toBeEnabled();
  await fill(page);
  api.next = { status: 400, code: 'FORM_EXPIRED' };
  await page.getByRole('button', { name: 'Enviar' }).click();
  await expect(page.getByRole('alert').filter({ hasText: /aberto por muito tempo/ })).toBeVisible(
    SEND,
  );
  // O token novo chega e a pessoa reenvia na hora: o POST só sai depois de 3,5 s do token.
  api.next = { status: 202 };
  await expect(page.getByRole('button', { name: 'Enviar' })).toBeEnabled();
  await page.getByRole('button', { name: 'Enviar' }).click();
  await expect(page.getByRole('button', { name: 'Enviando…' })).toBeVisible();
  await expect(page.getByTestId('contato-enviado')).toHaveText(ACCEPTED, SEND);
  const posts = api.calls.filter((call) => call.method === 'POST');
  expect(posts).toHaveLength(2);
  expect(tokenAgeAtPost(api, 1)).toBeGreaterThanOrEqual(3_400);
  // O pedido chegou à rota com os dados do formulário e o token novo.
  expect(posts[1]?.body).toMatchObject({ name: FILLED.name, email: FILLED.email });
  expect((posts[1]?.body as { formToken: string }).formToken).not.toBe(
    (posts[0]?.body as { formToken: string }).formToken,
  );
});

async function openEnterpriseModal(page: Page): Promise<ContactApi> {
  const api = await installApi(page, { role: 'OWNER' });
  await installBillingApi(page, api, newBilling());
  const contact = await installContactApi(page);
  await page.goto('/painel/assinatura');
  await page.getByRole('tab', { name: 'Planos' }).click();
  await page
    .getByTestId('cartao-enterprise')
    .getByRole('button', { name: 'Falar com a gente' })
    .click();
  await expect(page.getByRole('dialog', { name: 'Falar com a gente' })).toBeVisible();
  return contact;
}

test('envio imediato depois de abrir o Modal: o POST espera o tempo mínimo e o pedido chega', async ({
  page,
}) => {
  const contact = await openEnterpriseModal(page);
  const dialog = page.getByRole('dialog', { name: 'Falar com a gente' });
  await expect(dialog.getByRole('button', { name: 'Enviar' })).toBeEnabled();
  await fill(page);
  await dialog.getByRole('button', { name: 'Enviar' }).click();
  await expect(dialog.getByTestId('contato-enviado')).toHaveText(ACCEPTED, SEND);
  expect(contact.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  expect(tokenAgeAtPost(contact, 0)).toBeGreaterThanOrEqual(3_400);
});

test('fechar o Modal com algo escrito pede confirmação; vazio fecha direto', async ({ page }) => {
  await openEnterpriseModal(page);
  const dialog = page.getByRole('dialog', { name: 'Falar com a gente' });
  const confirm = page.getByRole('dialog', { name: 'Descartar o que você escreveu?' });
  await dialog.getByLabel('Seu nome').fill(FILLED.name);

  // Esc abre a confirmação com o foco no botão seguro; Esc de novo cancela e o rascunho fica.
  await page.keyboard.press('Escape');
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole('button', { name: 'Cancelar' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Seu nome')).toHaveValue(FILLED.name);

  // "Fechar" também pergunta; "Descartar" fecha e apaga.
  await dialog.getByRole('button', { name: 'Fechar' }).click();
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Descartar' }).click();
  await expect(dialog).toBeHidden();
  await page
    .getByTestId('cartao-enterprise')
    .getByRole('button', { name: 'Falar com a gente' })
    .click();
  await expect(dialog.getByLabel('Seu nome')).toHaveValue('');

  // Vazio: Esc fecha direto, sem confirmação.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(confirm).toBeHidden();
});
