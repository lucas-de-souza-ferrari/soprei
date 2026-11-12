import { expect, test, type Page } from '@playwright/test';
import {
  answerLogin,
  APP_ID,
  CONFIG_ID,
  coexistenceFinishEvent,
  company,
  conversation,
  finishEvent,
  installApi,
  message,
  PERMISSIONS,
  PHONE_NUMBER_ID,
  postFromPopup,
  SENTINEL,
  WABA_ID,
  type FakeApi,
} from './company-fixture';

// Spec 039: coexistência com o aplicativo WhatsApp Business (E1) e a pausa da IA no painel (E4).
const WWW = 'https://www.facebook.com';
const CODE = 'CODE-SECRETO-COEX-039';
const SETUP_WITH_COEXISTENCE = {
  embeddedSignup: { appId: APP_ID, configId: CONFIG_ID, graphApiVersion: 'v26.0' },
  manualConnect: false,
  coexistence: { available: true, configId: CONFIG_ID },
};

const signupCalls = (api: FakeApi) =>
  api.calls.filter((call) => call.path.endsWith('/channel/embedded-signup'));
const logins = (page: Page) =>
  page.evaluate(() => (window as unknown as { __fb: { logins: object[] } }).__fb.logins);

async function expectNothingStored(page: Page, secrets: string[]): Promise<void> {
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

async function checkAll(page: Page): Promise<void> {
  const boxes = page.getByRole('checkbox');
  const count = await boxes.count();
  for (let index = 0; index < count; index += 1) await boxes.nth(index).check();
}

for (const theme of ['light', 'dark'] as const) {
  test(`coexistência: escolha, checklist, featureType só aqui e envio com mode (tema ${theme})`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript((value) => localStorage.setItem('soprei-theme', value), theme);
    const consoleLines: string[] = [];
    page.on('console', (entry) => consoleLines.push(entry.text()));
    const api = await installApi(page, { setup: SETUP_WITH_COEXISTENCE });
    await page.goto('/painel/canal');

    await expect(page.getByRole('heading', { name: 'Como você quer conectar?' })).toBeVisible();
    await expect(
      page.getByText('Uso o WhatsApp Business no celular e quero continuar usando'),
    ).toBeVisible();
    await expect(page.getByText('Vou usar um número novo, só para o Soprei')).toBeVisible();
    await expect(page.getByText(/Instale o WhatsApp Business no celular/)).toBeVisible();

    await page.getByRole('button', { name: 'Conectar pelo aplicativo' }).click();
    const next = page.getByRole('button', { name: 'Continuar na Meta' });
    await expect(page.getByRole('checkbox')).toHaveCount(5);
    await expect(next).toBeDisabled();
    const boxes = page.getByRole('checkbox');
    for (let index = 0; index < 4; index += 1) await boxes.nth(index).check();
    await expect(next).toBeDisabled();
    await boxes.nth(4).check();
    await expect(next).toBeEnabled();
    await page.screenshot({
      path: `test-results/canal-coexistencia-${testInfo.project.name}-${theme}.png`,
      fullPage: true,
    });

    await next.click();
    expect(await logins(page)).toEqual([
      {
        config_id: CONFIG_ID,
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup: {}, featureType: 'whatsapp_business_app_onboarding' },
      },
    ]);
    // O evento chega antes do callback do FB.login (ordem vista no E0).
    await postFromPopup(page, WWW, coexistenceFinishEvent());
    expect(signupCalls(api)).toHaveLength(0);
    await answerLogin(page, CODE);
    await expect(page.getByRole('heading', { name: 'Conectado pelo aplicativo' })).toBeVisible();
    expect(signupCalls(api)[0]?.body).toEqual({
      code: CODE,
      wabaId: WABA_ID,
      phoneNumberId: PHONE_NUMBER_ID,
      mode: 'coexistence',
    });
    await expect(page.getByText(/a IA para de responder esse contato por 12 horas/)).toBeVisible();
    await expectNothingStored(page, [CODE, WABA_ID, PHONE_NUMBER_ID]);
    expect(consoleLines.join('\n')).not.toContain(CODE);
    expect(await page.content()).not.toContain(CODE);
  });
}

test('número novo: o FB.login NÃO recebe featureType e o corpo segue o contrato da 023', async ({
  page,
}) => {
  const api = await installApi(page, { setup: SETUP_WITH_COEXISTENCE });
  await page.goto('/painel/canal');
  await page.getByRole('button', { name: 'Conectar um número novo' }).click();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  const next = page.getByRole('button', { name: 'Continuar na Meta' });
  await expect(next).toBeEnabled();
  await next.click();
  expect(await logins(page)).toEqual([
    {
      config_id: CONFIG_ID,
      response_type: 'code',
      override_default_response_type: true,
      extras: { setup: {} },
    },
  ]);
  await postFromPopup(page, WWW, finishEvent());
  await answerLogin(page, CODE);
  await expect(page.getByText('Conectado.', { exact: true })).toBeVisible();
  expect(signupCalls(api)[0]?.body).toEqual({
    code: CODE,
    wabaId: WABA_ID,
    phoneNumberId: PHONE_NUMBER_ID,
  });
});

test('sem a flag do servidor a escolha não aparece (o fluxo da 023 segue igual)', async ({
  page,
}) => {
  await installApi(page);
  await page.goto('/painel/canal');
  await expect(
    page.getByRole('button', { name: 'Conectar com a Meta', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Como você quer conectar?' })).toHaveCount(0);
});

test('janela fechada sem terminar: mensagem fixa e as três causas, sem texto da Meta', async ({
  page,
}) => {
  await installApi(page, { setup: SETUP_WITH_COEXISTENCE });
  await page.goto('/painel/canal');
  await page.getByRole('button', { name: 'Conectar pelo aplicativo' }).click();
  await checkAll(page);
  await page.getByRole('button', { name: 'Continuar na Meta' }).click();
  await answerLogin(page, null);
  await expect(page.getByText('A conexão não terminou.').first()).toBeVisible();
  await expect(page.getByText(/em uso em outra plataforma de atendimento/)).toBeVisible();
  await expect(page.getByText(/desatualizado ou fechado/)).toBeVisible();
  await expect(page.getByText(/não tem acesso ao portfólio/)).toBeVisible();
  expect(await page.content()).not.toContain('current_step');
});

test('servidor recusa (número ambíguo): mensagem escolhida pelo código, nunca o texto do servidor', async ({
  page,
}) => {
  await installApi(page, {
    setup: SETUP_WITH_COEXISTENCE,
    signup: { status: 400, code: 'CHANNEL_NUMBER_AMBIGUOUS' },
  });
  await page.goto('/painel/canal');
  await page.getByRole('button', { name: 'Conectar pelo aplicativo' }).click();
  await checkAll(page);
  await page.getByRole('button', { name: 'Continuar na Meta' }).click();
  await postFromPopup(page, WWW, coexistenceFinishEvent());
  await answerLogin(page, CODE);
  await expect(
    page.getByText('Não foi possível identificar o número. Escolha o número no aplicativo'),
  ).toBeVisible();
  expect(await page.content()).not.toContain(SENTINEL);
});

// --- E4: a pausa da IA no painel ---

const TAKEOVER = [...PERMISSIONS.AGENT, 'conversation:takeover'];

for (const theme of ['light', 'dark'] as const) {
  test(`conversa pausada: bolha da equipe, faixa e "Reativar a IA" baixa o selo (tema ${theme})`, async ({
    page,
  }) => {
    await page.addInitScript((value) => localStorage.setItem('soprei-theme', value), theme);
    const agent = { ...company('Empresa A', 'AGENT'), permissions: TAKEOVER };
    const api = await installApi(page, { companies: [agent], selected: agent.companyId });
    const paused = {
      ...conversation('Contato final 1234'),
      aiPausedUntil: new Date(Date.now() + 6 * 3_600_000).toISOString(),
    };
    api.conversations = [paused];
    api.history = {
      [paused.id]: [
        message('USER', 'preciso de ajuda', 10),
        message('HUMAN', 'Oi! Aqui é a Ana, já te ajudo.', 8),
      ],
    };
    await page.goto('/painel/conversas');
    const badge = page.getByTestId('ai-paused-badge');
    await expect(badge).toHaveText('IA pausada');

    await page.getByRole('link', { name: /Contato final 1234/ }).click();
    await expect(page.getByText('Equipe (pelo celular)')).toBeVisible();
    const human = page.locator('li[data-mine="true"]').filter({ hasText: 'Aqui é a Ana' });
    await expect(human).toHaveCount(1);
    const banner = page.getByTestId('ai-pause-banner');
    await expect(banner).toContainText('A IA está pausada neste contato até');
    await expect(banner).toContainText('porque a equipe respondeu pelo celular');

    await banner.getByRole('button', { name: 'Reativar a IA' }).click();
    await expect(page.getByTestId('ai-pause-banner')).toHaveCount(0);
    expect(
      api.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/ai/resume')),
    ).toHaveLength(1);
    await page.getByRole('link', { name: 'Voltar às conversas' }).click();
    await expect(page.getByRole('link', { name: /Contato final 1234/ })).toBeVisible();
    await expect(page.getByTestId('ai-paused-badge')).toHaveCount(0);
  });
}

test('VIEWER vê a faixa de pausa, mas não o botão "Reativar a IA"', async ({ page }) => {
  const viewer = company('Empresa A', 'VIEWER');
  const api = await installApi(page, { companies: [viewer], selected: viewer.companyId });
  const paused = {
    ...conversation('Contato final 1234'),
    aiPausedUntil: new Date(Date.now() + 3_600_000).toISOString(),
  };
  api.conversations = [paused];
  api.history = { [paused.id]: [message('HUMAN', 'resposta da equipe', 3)] };
  await page.goto(`/painel/conversas/${paused.id}`);
  await expect(page.getByTestId('ai-pause-banner')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reativar a IA' })).toHaveCount(0);
});
