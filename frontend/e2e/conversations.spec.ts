import { expect, test, type Page } from '@playwright/test';
import {
  closeMenu,
  company,
  conversation,
  holdList,
  installApi,
  menuItems,
  message,
  openMenu,
  PERMISSIONS,
  SENTINEL,
  switchTo,
  type FakeApi,
  type FakeConversation,
  type FakeMessage,
  type Role,
} from './company-fixture';

/** Telefone e wamid que o servidor mascarou: a API falsa nunca os devolve e a tela nunca os mostra. */
const PHONE = '5511999991234';
const WAMID = `wamid.${Buffer.from(PHONE).toString('base64')}`;

function seed(
  api: FakeApi,
  conversations: FakeConversation[],
  rows: Record<string, FakeMessage[]> = {},
) {
  api.conversations = conversations;
  api.history = rows;
}

const conversationCalls = (api: FakeApi) =>
  api.calls.filter((call) => call.path.includes('/conversations'));

async function expectNoSecretsStored(page: Page, secrets: string[]): Promise<void> {
  const stored = await page.evaluate(() => ({
    keys: [...Object.keys(localStorage), ...Object.keys(sessionStorage)],
    values: [...Object.values(localStorage), ...Object.values(sessionStorage)].join('|'),
    href: location.href,
    title: document.title,
  }));
  expect(stored.keys.filter((key) => key !== 'soprei-theme')).toEqual([]);
  for (const secret of secrets) {
    expect(stored.values).not.toContain(secret);
    expect(stored.href).not.toContain(secret);
    expect(stored.title).not.toContain(secret);
  }
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

for (const theme of ['light', 'dark'] as const) {
  test(`lista de conversas: rótulos mascarados, selo Teste, links e ordem (tema ${theme})`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript((value) => localStorage.setItem('soprei-theme', value), theme);
    const api = await installApi(page);
    const first = conversation('Contato final 1234', 'whatsapp', 5);
    const second = conversation('Teste no site', 'simulator', 60 * 30);
    const third = conversation('Simulador a1b2', 'simulator', 60 * 24 * 5);
    seed(api, [first, second, third]);
    await page.goto('/painel/conversas');

    await expect(page.getByRole('heading', { level: 2, name: 'Conversas' })).toBeVisible();
    const links = page.getByRole('list', { name: /Conversas, da mais recente/ }).getByRole('link');
    await expect(links).toHaveCount(3);
    await expect(links.nth(0)).toContainText('Contato final 1234');
    await expect(links.nth(1)).toContainText('Teste no site');
    await expect(links.nth(1)).toContainText('Teste');
    await expect(links.nth(2)).toContainText('Simulador a1b2');
    await expect(links.nth(0)).toHaveAttribute('href', `/painel/conversas/${first.id}`);
    const nav = await openMenu(page);
    await expect(nav.getByRole('link', { name: 'Conversas' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await closeMenu(page);
    // Sem prévia nem contagem por conversa; só rótulo, selo e data/hora.
    expect(await links.nth(0).locator('time').getAttribute('datetime')).toBe(first.updatedAt);

    // Nenhum telefone, wamid, `contactRef` ou texto do servidor na página.
    const text = (await page.locator('body').innerText()) + (await page.content());
    for (const secret of [PHONE, PHONE.slice(0, 8), WAMID, 'contactRef', SENTINEL]) {
      expect(text).not.toContain(secret);
    }
    await noHorizontalScroll(page);
    await page.screenshot({
      path: `test-results/conversas-${testInfo.project.name}-${theme}.png`,
      fullPage: true,
    });
  });
}

test('lista: carregando, vazia com orientação por permissão e sem prévia', async ({ page }) => {
  const api = await installApi(page);
  holdList(api);
  await page.goto('/painel/conversas');
  await expect(page.getByText('Carregando conversas…')).toBeVisible();
  api.releaseList();
  await expect(page.getByText('Ainda não há conversas.')).toBeVisible();
  const guide = page.getByText(/Conecte o número em/);
  await expect(guide).toContainText('Conecte o número em Canal ou use Testar para criar');
  await guide.getByRole('link', { name: 'Testar' }).click();
  await expect(page.getByLabel('Mensagem de teste')).toBeVisible();

  // Atendente: só Testar; a orientação oferece só o que a pessoa pode abrir.
  const agent = await installApi(page, { role: 'AGENT' });
  await page.goto('/painel/conversas');
  await expect(page.getByText(/Use Testar para criar uma conversa de teste/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Canal' })).toHaveCount(0);
  expect(conversationCalls(agent).length).toBeGreaterThan(0);

  // Somente leitura: nenhuma orientação com link.
  await installApi(page, { role: 'VIEWER' });
  await page.goto('/painel/conversas');
  await expect(page.getByText('Ainda não há conversas.')).toBeVisible();
  await expect(page.locator('main').getByRole('link', { name: /Canal|Testar/ })).toHaveCount(0);
});

test('lista: "Carregar mais" anexa sem duplicar, anuncia e mantém o foco; Atualizar volta à primeira página', async ({
  page,
}) => {
  const api = await installApi(page);
  const all = Array.from({ length: 65 }, (_, index) =>
    conversation(`Simulador ${String(index).padStart(4, '0')}`, 'simulator', index + 1),
  );
  seed(api, all);
  await page.goto('/painel/conversas');
  const links = page.getByRole('list', { name: /Conversas, da mais recente/ }).getByRole('link');
  await expect(links).toHaveCount(30);
  const status = page.getByRole('status').filter({ hasText: /conversas? carregadas?/ });
  await expect(status).toHaveText('30 conversas carregadas');

  await page.getByRole('button', { name: 'Carregar mais' }).click();
  await expect(links).toHaveCount(60);
  await expect(status).toHaveText('60 conversas carregadas');
  // O foco vai para a primeira conversa nova (o botão continua, mas a leitura segue dali).
  await expect(links.nth(30)).toBeFocused();

  await page.getByRole('button', { name: 'Carregar mais' }).click();
  await expect(links).toHaveCount(65);
  await expect(page.getByRole('button', { name: 'Carregar mais' })).toHaveCount(0);
  await expect(links.nth(60)).toBeFocused();
  const hrefs = await links.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')));
  expect(new Set(hrefs).size).toBe(65);
  const requests = conversationCalls(api).map((call) => call.path);
  expect(requests.every((path) => path.endsWith('/conversations'))).toBe(true);

  // Atualizar: relê a primeira página e descarta o que estava carregado; entra conversa nova no topo.
  const fresh = conversation('Contato final 9999', 'whatsapp', 0);
  api.conversations = [fresh, ...all];
  await page.getByRole('button', { name: 'Atualizar' }).click();
  await expect(links).toHaveCount(30);
  await expect(links.nth(0)).toContainText('Contato final 9999');
  await expect(page.getByRole('button', { name: 'Carregar mais' })).toBeVisible();
});

test('lista: erro com "Tentar de novo"; erro ao carregar mais mantém os itens', async ({
  page,
}) => {
  const api = await installApi(page);
  seed(
    api,
    Array.from({ length: 40 }, (_, index) =>
      conversation(`Simulador ${String(index)}`, 'simulator', index + 1),
    ),
  );
  api.failures.list = true;
  await page.goto('/painel/conversas');
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Não foi possível concluir. Tente novamente.');
  await expect(page.getByRole('link', { name: /Simulador/ })).toHaveCount(0);
  api.failures.list = false;
  await alert.getByRole('button', { name: 'Tentar de novo' }).click();
  const links = page.getByRole('list', { name: /Conversas, da mais recente/ }).getByRole('link');
  await expect(links).toHaveCount(30);

  api.failures.more = true;
  await page.getByRole('button', { name: 'Carregar mais' }).click();
  await expect(page.getByRole('alert')).toContainText('Não foi possível concluir');
  await expect(links).toHaveCount(30);
  api.failures.more = false;
  await page.getByRole('alert').getByRole('button', { name: 'Tentar de novo' }).click();
  await expect(links).toHaveCount(40);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(SENTINEL);
});

test('abrir uma conversa: URL só com o id, ordem cronológica, abre nas mais recentes e carrega anteriores sem perder a posição', async ({
  page,
}) => {
  const api = await installApi(page);
  const target = conversation('Contato final 1234', 'whatsapp', 1);
  const rows: FakeMessage[] = [];
  for (let index = 0; index < 120; index++) {
    // 120 mensagens, a mais antiga com 600 minutos; a última é do assistente.
    const role = index % 2 === 0 ? 'USER' : 'ASSISTANT';
    rows.push(message(role, `Mensagem ${String(index + 1).padStart(3, '0')}`, 600 - index * 5));
  }
  seed(api, [target], { [target.id]: rows });
  await page.goto('/painel/conversas');
  await page.getByRole('link', { name: /Contato final 1234/ }).click();

  await expect(page).toHaveURL(new RegExp(`/painel/conversas/${target.id}$`));
  await expect(page.getByRole('heading', { level: 2, name: 'Contato final 1234' })).toBeVisible();
  const items = page.getByRole('list', { name: /Mensagens, da mais antiga/ }).getByRole('listitem');
  // 50 mensagens mais recentes (a 71 até a 120), mais separadores de dia.
  await expect(page.getByText('Mensagem 120')).toBeVisible();
  await expect(page.getByText('Mensagem 071')).toBeAttached();
  await expect(page.getByText('Mensagem 070')).toHaveCount(0);
  const texts = await page
    .locator('[aria-label="Mensagens da conversa"] ol li:not([role="separator"]) p[dir="auto"]')
    .allTextContents();
  expect(texts).toHaveLength(50);
  expect(texts[0]).toBe('Mensagem 071');
  expect(texts.at(-1)).toBe('Mensagem 120');
  // Abriu na última mensagem (rolagem até o fim).
  const region = page.getByRole('region', { name: 'Mensagens da conversa' });
  const atEnd = await region.evaluate(
    (node) => node.scrollHeight - node.scrollTop - node.clientHeight,
  );
  expect(atEnd).toBeLessThanOrEqual(2);
  expect(await items.count()).toBe(50);

  // Carregar anteriores: prepende, não rola e o foco volta à mensagem em que a leitura estava.
  const anchor = page.getByText('Mensagem 071');
  const before = await anchor.evaluate((node) => node.getBoundingClientRect().top);
  await region.evaluate((node) => (node.scrollTop = 0));
  const beforeScroll = await anchor.evaluate((node) => node.getBoundingClientRect().top);
  await page.getByRole('button', { name: 'Carregar mensagens anteriores' }).click();
  await expect(page.getByText('Mensagem 021')).toBeAttached();
  await expect(page.getByText('Mensagem 070')).toBeAttached();
  const afterTexts = await page
    .locator('[aria-label="Mensagens da conversa"] ol li:not([role="separator"]) p[dir="auto"]')
    .allTextContents();
  expect(afterTexts).toHaveLength(100);
  expect(afterTexts[0]).toBe('Mensagem 021');
  expect(new Set(afterTexts).size).toBe(100);
  // A mensagem que o leitor via continua no mesmo lugar da tela.
  const afterScroll = await anchor.evaluate((node) => node.getBoundingClientRect().top);
  expect(Math.abs(afterScroll - beforeScroll)).toBeLessThanOrEqual(2);
  expect(before).not.toBeNull();
  // O foco ficou na mensagem que era a primeira.
  const focused = await page.evaluate(() => document.activeElement?.textContent ?? '');
  expect(focused).toContain('Mensagem 071');

  // Atualizar: relê as mais recentes e rola ao fim.
  api.history[target.id]?.push(message('USER', 'Mensagem nova 121', 0));
  await page.getByRole('button', { name: 'Atualizar' }).click();
  await expect(page.getByText('Mensagem nova 121')).toBeVisible();
  await expectNoSecretsStored(page, ['Mensagem 120', 'Contato final 1234', PHONE]);
  const requests = conversationCalls(api).filter((call) => call.path.endsWith('/messages'));
  expect(requests.length).toBeGreaterThan(0);
});

test('balões: autor em texto, resposta padrão, Enviando… e Não enviada só no WhatsApp', async ({
  page,
}) => {
  const api = await installApi(page);
  const whatsapp = conversation('Contato final 1234', 'whatsapp', 1);
  const simulator = conversation('Teste no site', 'simulator', 2);
  const unsent = (minutesAgo: number) =>
    message('ASSISTANT', `Resposta há ${String(minutesAgo)} min`, minutesAgo, { sentAt: null });
  seed(api, [whatsapp, simulator], {
    [whatsapp.id]: [
      message('USER', 'Oi, tudo bem?', 20),
      message('ASSISTANT', 'Tudo bem! Como ajudo?', 19.5),
      message('USER', 'Qual o horário?', 10),
      message('ASSISTANT', 'Desculpe, estou com dificuldades.', 9.5, { isFallback: true }),
      message('USER', 'E amanhã?', 5),
      unsent(4),
      message('USER', 'Ainda aí?', 0.4),
      message('ASSISTANT', 'Já respondo', 0.2, { sentAt: null }),
    ],
    [simulator.id]: [message('USER', 'Mensagem do simulador', 5), unsent(4.5)],
  });
  await page.goto(`/painel/conversas/${whatsapp.id}`);
  const region = page.getByRole('region', { name: 'Mensagens da conversa' });
  await expect(region.getByText('Contato', { exact: true }).first()).toBeVisible();
  await expect(region.getByText('Assistente', { exact: true }).first()).toBeVisible();
  await expect(region.getByText('Resposta padrão: houve falha ao gerar a resposta')).toHaveCount(1);
  await expect(region.getByText('Não enviada ao WhatsApp')).toHaveCount(1);
  await expect(region.getByText('Confira o estado do canal em Canal')).toHaveCount(1);
  await expect(region.getByText('Enviando…')).toHaveCount(1);
  await expect(page.getByText('Teste', { exact: true })).toHaveCount(0);

  // Conversa de simulador: selo Teste e nenhum indicador de envio (nunca vai ao canal).
  await page.goto(`/painel/conversas/${simulator.id}`);
  await expect(page.getByRole('heading', { level: 2, name: 'Teste no site' })).toBeVisible();
  await expect(page.getByText('Teste', { exact: true })).toBeVisible();
  await expect(page.getByText(/Não enviada ao WhatsApp|Enviando…/)).toHaveCount(0);
});

test('o limite de 2 minutos usa o relógio: Enviando… vira Não enviada ao WhatsApp sem recarregar', async ({
  page,
}) => {
  const api = await installApi(page);
  const target = conversation('Contato final 1234', 'whatsapp', 1);
  const reply = message('ASSISTANT', 'Resposta ainda sem envio', 0, { sentAt: null });
  seed(api, [target], { [target.id]: [message('USER', 'Pergunta', 0.1), reply] });
  await page.clock.install({ time: new Date(reply.createdAt).getTime() + 10_000 });
  await page.goto(`/painel/conversas/${target.id}`);
  await expect(page.getByText('Enviando…')).toBeVisible();
  await page.clock.fastForward(130_000);
  await expect(page.getByText('Não enviada ao WhatsApp')).toBeVisible();
  await expect(page.getByText('Enviando…')).toHaveCount(0);
});

test('mensagens estranhas: 4000 caracteres, emoji, RTL e HTML aparecem como texto, sem estourar o layout', async ({
  page,
}) => {
  const api = await installApi(page);
  const target = conversation('Contato final 1234', 'whatsapp', 1);
  const long = `${'a'.repeat(1990)}${'b'.repeat(2010)}`;
  const html = '<script>window.__pwned = true</script> <b>negrito</b> **markdown** [x](http://a.b)';
  seed(api, [target], {
    [target.id]: [
      message('USER', long, 30),
      message('ASSISTANT', 'Olá 👋🏽 família 👨‍👩‍👧 café', 29),
      message('USER', 'مرحبا بالعالم שלום', 28),
      message('USER', 'linha 1\nlinha 2\n\nlinha 4', 27),
      message('USER', html, 26),
    ],
  });
  await page.goto(`/painel/conversas/${target.id}`);
  await expect(page.getByText('Olá 👋🏽 família 👨‍👩‍👧 café')).toBeVisible();
  await expect(page.getByText('مرحبا بالعالم שלום')).toBeVisible();
  await expect(page.getByText(html, { exact: true })).toBeVisible();
  await expect(page.getByText(long, { exact: true })).toBeAttached();
  expect(
    await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned),
  ).toBeUndefined();
  await expect(page.locator('main li b, main li a, main li script')).toHaveCount(0);
  await expect(page.locator('p[dir="auto"]').first()).toHaveAttribute('dir', 'auto');
  // Quebras de linha preservadas.
  const multi = page.locator('p[dir="auto"]').filter({ hasText: 'linha 4' });
  expect(await multi.evaluate((node) => getComputedStyle(node).whiteSpace)).toBe('pre-wrap');
  await noHorizontalScroll(page);
  const region = page.getByRole('region', { name: 'Mensagens da conversa' });
  expect(await region.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(
    0,
  );
});

test('360 px de largura: lista e histórico sem rolagem horizontal', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const api = await installApi(page);
  const target = conversation('Contato final 1234', 'whatsapp', 1);
  seed(api, [target], {
    [target.id]: [
      message('USER', 'x'.repeat(300), 3),
      message('ASSISTANT', 'Resposta', 2, { sentAt: null, isFallback: true }),
    ],
  });
  await page.goto('/painel/conversas');
  await expect(page.getByRole('link', { name: /Contato final 1234/ })).toBeVisible();
  await noHorizontalScroll(page);
  await page.getByRole('link', { name: /Contato final 1234/ }).click();
  await expect(page.getByText('Resposta padrão: houve falha ao gerar a resposta')).toBeVisible();
  await noHorizontalScroll(page);
});

test('conversa sem mensagens, erro com Tentar de novo e id malformado sem chamar a API', async ({
  page,
}) => {
  const api = await installApi(page);
  const empty = conversation('Teste no site', 'simulator', 1);
  const broken = conversation('Contato final 1234', 'whatsapp', 2);
  seed(api, [empty, broken], { [empty.id]: [], [broken.id]: [message('USER', 'Oi', 3)] });
  await page.goto(`/painel/conversas/${empty.id}`);
  await expect(page.getByText('Esta conversa ainda não tem mensagens.')).toBeVisible();

  api.failures.history = true;
  await page.goto(`/painel/conversas/${broken.id}`);
  await expect(page.getByRole('alert')).toContainText('Não foi possível concluir');
  api.failures.history = false;
  await page.getByRole('alert').getByRole('button', { name: 'Tentar de novo' }).click();
  await expect(page.getByText('Oi', { exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(SENTINEL);

  const before = conversationCalls(api).length;
  await page.goto('/painel/conversas/nao-e-um-uuid');
  await expect(page.getByText('Conversa não encontrada.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Voltar às conversas' })).toBeVisible();
  expect(conversationCalls(api).length).toBe(before);
});

test('404: mesma empresa mostra "Conversa não encontrada"; empresa trocada segue o fluxo "A empresa selecionada mudou"', async ({
  page,
}) => {
  const first = company('Empresa A');
  const second = company('Empresa B');
  const api = await installApi(page, { companies: [first, second], selected: first.companyId });
  seed(api, []);
  // id bem formado, mas que a empresa não tem (inexistente ou de outra empresa: o servidor não diz qual).
  await page.goto(`/painel/conversas/018f3c1e-5b7a-7c3e-9f10-2a4b6c8d0e1f`);
  await expect(page.getByText('Conversa não encontrada.')).toBeVisible();
  await page.getByRole('link', { name: 'Voltar às conversas' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Conversas' })).toBeVisible();
  await expect(page).toHaveURL(/\/painel\/conversas$/);

  // Outra aba trocou a empresa: depois do 404, a sessão mostra a empresa B.
  const target = conversation('Contato final 1234', 'whatsapp', 1);
  seed(api, [target], { [target.id]: [message('USER', 'Oi', 1)] });
  await page.route('**/api/admin/companies/*/conversations/*/messages*', async (route) => {
    api.selected = second.companyId;
    await route.fulfill({
      status: 404,
      json: { error: { code: 'NOT_FOUND', message: SENTINEL, requestId: 'x' } },
    });
  });
  await page.goto(`/painel/conversas/${target.id}`);
  await expect(page.getByText('A empresa selecionada mudou. Escolha de novo.')).toBeVisible();
  await expect(page.getByText('Suas empresas')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(SENTINEL);
});

for (const role of ['OWNER', 'ADMIN', 'AGENT', 'VIEWER'] as Role[]) {
  test(`permissão: ${role} vê a aba Conversas como primeira e abre a lista`, async ({ page }) => {
    const api = await installApi(page, { role });
    seed(api, [conversation('Teste no site', 'simulator', 1)]);
    await page.goto('/painel/empresas');
    await page.getByRole('button', { name: 'Abrir painel' }).click();
    // A página inicial do painel é a de Conversas.
    await expect(page.getByRole('heading', { level: 2, name: 'Conversas' })).toBeVisible();
    expect((await menuItems(page))[0]).toBe('Conversas');
    await expect(page).toHaveURL(/\/painel\/conversas$/);
  });
}

test('sem conversation:read: a aba some e a URL forçada mostra "sem permissão" sem chamar a API', async ({
  page,
}) => {
  const limited = { ...company('Empresa A', 'AGENT'), permissions: ['conversation:simulate'] };
  const api = await installApi(page, { companies: [limited], selected: limited.companyId });
  await page.goto('/painel/conversas');
  const limitedMenu = await menuItems(page);
  expect(limitedMenu).not.toContain('Conversas');
  expect(limitedMenu).toContain('Testar');
  await expect(page.getByText('Você não tem permissão para ver esta tela.')).toBeVisible();
  await page.goto(`/painel/conversas/018f3c1e-5b7a-7c3e-9f10-2a4b6c8d0e1f`);
  await expect(page.getByText('Você não tem permissão para ver esta tela.')).toBeVisible();
  expect(conversationCalls(api)).toHaveLength(0);

  const none = { ...company('Empresa B', 'VIEWER'), permissions: [] as string[] };
  const bare = await installApi(page, { companies: [none], selected: none.companyId });
  await page.goto('/painel/conversas');
  await expect(page.getByText('Você não tem permissão para usar nenhuma tela')).toBeVisible();
  expect(conversationCalls(bare)).toHaveLength(0);
  expect(PERMISSIONS.VIEWER).toContain('conversation:read');
});

test('trocar de empresa durante o carregamento descarta a resposta tardia', async ({ page }) => {
  const first = company('Empresa A');
  const second = company('Empresa B');
  const api = await installApi(page, { companies: [first, second], selected: first.companyId });
  seed(api, [conversation('Contato final 1111', 'whatsapp', 1)]);
  holdList(api);
  await page.goto('/painel/conversas');
  await expect(page.getByText('Carregando conversas…')).toBeVisible();
  await switchTo(page, 'Empresa B');
  // A empresa B tem outra conversa; a resposta tardia da A não pode aparecer na B.
  seed(api, [conversation('Contato final 2222', 'whatsapp', 1)]);
  api.releaseList();
  await expect(page.getByRole('link', { name: /Contato final 2222/ })).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.getByText('Contato final 1111')).toHaveCount(0);
});

test('voltar e avançar do navegador preservam a empresa e a seleção sobrevive a atualizar a página', async ({
  page,
}) => {
  const first = company('Empresa A');
  const second = company('Empresa B');
  const api = await installApi(page, { companies: [first, second], selected: second.companyId });
  const target = conversation('Contato final 1234', 'whatsapp', 1);
  seed(api, [target], { [target.id]: [message('USER', 'Olá da B', 1)] });
  await page.goto('/painel/conversas');
  await page.getByRole('link', { name: /Contato final 1234/ }).click();
  await expect(page.getByText('Olá da B')).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/painel\/conversas$/);
  await expect(page.getByRole('link', { name: /Contato final 1234/ })).toBeVisible();
  await openMenu(page);
  await expect(page.getByRole('button', { name: /Trocar de empresa/ })).toContainText('Empresa B');
  await closeMenu(page);
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/painel/conversas/${target.id}$`));
  await expect(page.getByText('Olá da B')).toBeVisible();

  // Atualizar a página na conversa: a empresa selecionada é a mesma e o cabeçalho vem da API.
  await page.reload();
  await openMenu(page);
  await expect(page.getByRole('button', { name: /Trocar de empresa/ })).toContainText('Empresa B');
  await closeMenu(page);
  await expect(page.getByRole('heading', { level: 2, name: 'Contato final 1234' })).toBeVisible();
  await expect(page.getByText('Olá da B')).toBeVisible();
  expect(api.selected).toBe(second.companyId);
});

test('privacidade: nada de conteúdo, rótulo ou telefone no storage, título ou URL; só /api e fontes', async ({
  page,
}) => {
  const api = await installApi(page);
  const target = conversation('Contato final 1234', 'whatsapp', 1);
  seed(api, [target], { [target.id]: [message('USER', 'Mensagem privada do contato', 1)] });
  await page.goto('/painel/conversas');
  await page.getByRole('link', { name: /Contato final 1234/ }).click();
  await expect(page.getByText('Mensagem privada do contato')).toBeVisible();
  await page.getByRole('link', { name: 'Voltar às conversas' }).click();
  await expect(page.getByRole('link', { name: /Contato final 1234/ })).toBeVisible();
  await expectNoSecretsStored(page, [
    'Mensagem privada do contato',
    'Contato final 1234',
    PHONE,
    WAMID,
  ]);
  const location = new URL(page.url());
  expect(location.pathname).toBe('/painel/conversas');
  expect(location.search).toBe('');
  expect(api.external.filter((url) => !url.includes('fonts.g'))).toEqual([]);
  await expect(page.locator('body')).not.toContainText(SENTINEL);
});

test('foco por teclado percorre menu, lista, Carregar mais, Atualizar e Voltar', async ({
  page,
}) => {
  const api = await installApi(page);
  const all = Array.from({ length: 35 }, (_, index) =>
    conversation(`Simulador ${String(index)}`, 'simulator', index + 1),
  );
  seed(api, all, { [all[0]?.id ?? '']: [message('USER', 'Oi', 1)] });
  await page.goto('/painel/conversas');
  const links = page.getByRole('list', { name: /Conversas, da mais recente/ }).getByRole('link');
  await expect(links).toHaveCount(30);
  const nav = await openMenu(page);
  await page.getByRole('button', { name: /Trocar de empresa/ }).focus();
  await page.keyboard.press('Tab');
  await expect(nav.getByRole('link', { name: 'Conversas' })).toBeFocused();
  await closeMenu(page);
  await page.getByRole('button', { name: 'Atualizar' }).focus();
  await expect(page.getByRole('button', { name: 'Atualizar' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(links.first()).toBeFocused();
  for (let index = 0; index < 29; index++) await page.keyboard.press('Tab');
  await expect(links.nth(29)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Carregar mais' })).toBeFocused();

  // Enter abre a conversa e "Voltar às conversas" é alcançável pelo teclado.
  await links.first().focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('link', { name: 'Voltar às conversas' })).toBeVisible();
  await page.getByRole('link', { name: 'Voltar às conversas' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 2, name: 'Conversas' })).toBeVisible();
});
