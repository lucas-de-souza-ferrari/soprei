import { expect, test, type Page } from '@playwright/test';
import {
  answerLogin,
  company,
  CONFIG_ID,
  CONNECTED,
  APP_ID,
  finishEvent,
  hold,
  installApi,
  NOT_CONNECTED,
  PHONE_NUMBER_ID,
  postFromPopup,
  SENTINEL,
  WABA_ID,
  type FakeApi,
} from './company-fixture';

const WWW = 'https://www.facebook.com';
const SDK = 'connect.facebook.net';

const sdkRequests = (api: FakeApi): number =>
  api.external.filter((url) => url.includes(SDK)).length;
const channelCalls = (api: FakeApi) => api.calls.filter((call) => call.path.includes('/channel'));
const signupCalls = (api: FakeApi) =>
  api.calls.filter((call) => call.path.endsWith('/channel/embedded-signup'));

/** Clique 1 e clique 2: abre o painel, espera o SDK e abre o popup (o `FB.login` é do SDK falso). */
async function startConnect(page: Page, label = 'Conectar com a Meta'): Promise<void> {
  await page.getByRole('button', { name: label, exact: true }).click();
  const next = page.getByRole('button', { name: 'Continuar na Meta' });
  await expect(next).toBeEnabled();
  await next.click();
}

async function expectNoSecretsStored(page: Page, secrets: string[]): Promise<void> {
  const stored = await page.evaluate(() => ({
    keys: [...Object.keys(localStorage), ...Object.keys(sessionStorage)],
    values: [...Object.values(localStorage), ...Object.values(sessionStorage)].join('|'),
    href: location.href,
  }));
  expect(stored.keys.filter((key) => key !== 'soprei-theme')).toEqual([]);
  for (const secret of secrets) {
    expect(stored.values).not.toContain(secret);
    expect(stored.href).not.toContain(secret);
  }
}

for (const theme of ['light', 'dark'] as const) {
  test(`conectar pelo Embedded Signup e desconectar (tema ${theme})`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript((value) => localStorage.setItem('soprei-theme', value), theme);
    const api = await installApi(page);
    await page.goto('/painel/canal');
    await expect(page.getByText('Nenhum número conectado.')).toBeVisible();
    // O SDK não é requisitado ao abrir o site, a lista de empresas nem a aba Canal.
    expect(sdkRequests(api)).toBe(0);
    await expect(page.getByRole('tab', { name: 'Canal' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Persona' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Testar' })).toBeVisible();

    // Clique 1: painel explicativo (com o aviso de WABA compartilhada) e o SDK, uma única vez.
    await page.getByRole('button', { name: 'Conectar com a Meta', exact: true }).click();
    await expect(page.locator('#aviso-waba')).toContainText(
      'Uma conta do WhatsApp Business conecta a uma empresa só.',
    );
    const next = page.getByRole('button', { name: 'Continuar na Meta' });
    await expect(next).toBeEnabled();
    expect(sdkRequests(api)).toBe(1);
    await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await page.getByRole('button', { name: 'Conectar com a Meta', exact: true }).click();
    await expect(next).toBeEnabled();
    expect(sdkRequests(api)).toBe(1);
    expect(await page.locator(`script[src*="${SDK}"]`).count()).toBe(1);
    const inits = await page.evaluate(
      () => (window as unknown as { __fb: { inits: object[] } }).__fb.inits,
    );
    expect(inits).toEqual([
      { appId: APP_ID, autoLogAppEvents: false, xfbml: false, version: 'v26.0' },
    ]);

    // Clique 2: o `FB.login` roda dentro do clique, com os parâmetros confirmados na documentação.
    await next.click();
    const logins = await page.evaluate(
      () => (window as unknown as { __fb: { logins: object[] } }).__fb.logins,
    );
    expect(logins).toEqual([
      {
        config_id: CONFIG_ID,
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup: {} },
      },
    ]);
    await page.screenshot({
      path: `test-results/canal-${testInfo.project.name}-${theme}.png`,
      fullPage: true,
    });

    // O code e os ids chegam por canais diferentes, aqui na ordem "ids primeiro".
    await postFromPopup(page, WWW, finishEvent());
    expect(signupCalls(api)).toHaveLength(0);
    await answerLogin(page, 'CODE-SECRETO-123');
    await expect(page.getByText('Conectado.', { exact: true })).toBeVisible();
    expect(signupCalls(api)).toHaveLength(1);
    expect(signupCalls(api)[0]?.body).toEqual({
      code: 'CODE-SECRETO-123',
      wabaId: WABA_ID,
      phoneNumberId: PHONE_NUMBER_ID,
    });
    expect(Object.keys(signupCalls(api)[0]?.body as object)).toEqual([
      'code',
      'wabaId',
      'phoneNumberId',
    ]);
    await expect(page.getByText(PHONE_NUMBER_ID)).toBeVisible();

    // Desconectar: diálogo com o aviso da WABA; Esc fecha e devolve o foco ao botão de origem.
    const open = page.getByRole('button', { name: 'Desconectar', exact: true });
    await open.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Desconectar remove o acesso do Soprei à conta inteira');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(open).toBeFocused();
    expect(api.calls.some((call) => call.method === 'DELETE')).toBe(false);
    await open.click();
    await dialog.getByRole('button', { name: 'Desconectar', exact: true }).click();
    await expect(page.getByText('Nenhum número conectado.')).toBeVisible();
    expect(api.calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);

    await expectNoSecretsStored(page, ['CODE-SECRETO-123', PHONE_NUMBER_ID, WABA_ID]);
    // Além do script do SDK, só as fontes do próprio site (spec 018).
    expect(api.external.filter((url) => !url.includes(SDK) && !url.includes('fonts.g'))).toEqual(
      [],
    );
    await expect(page.locator('body')).not.toContainText(SENTINEL);
  });
}

test('evento com origem incorreta nao conclui a conexao; a origem correta conclui', async ({
  page,
}) => {
  const api = await installApi(page);
  await page.goto('/painel/canal');
  await startConnect(page);
  await answerLogin(page, 'CODE-1');
  for (const origin of [
    'https://evil.example',
    'http://www.facebook.com',
    'https://www.facebook.com.evil.example',
    'https://evilfacebook.com',
    'null',
  ]) {
    await postFromPopup(page, origin, finishEvent());
  }
  await postFromPopup(page, 'https://web.facebook.com', 'texto que nao e json');
  await page.waitForTimeout(400);
  expect(signupCalls(api)).toHaveLength(0);
  await postFromPopup(page, 'https://web.facebook.com', finishEvent());
  await expect(page.getByText('Conectado.', { exact: true })).toBeVisible();
  expect(signupCalls(api)).toHaveLength(1);
});

test('TOKEN_INVALID mostra o alerta e Reconectar refaz o fluxo; LEGACY mostra a orientacao', async ({
  page,
}) => {
  const api = await installApi(page, {
    channel: { ...CONNECTED, state: 'TOKEN_INVALID', tokenInvalidAt: '2026-11-04T13:00:00.000Z' },
  });
  await page.goto('/painel/canal');
  await expect(page.getByRole('alert')).toContainText('A Meta recusou o acesso');
  await expect(page.getByRole('alert')).toContainText('parou de responder');
  await startConnect(page, 'Reconectar');
  await answerLogin(page, 'CODE-2');
  await postFromPopup(page, WWW, finishEvent());
  await expect(page.getByText('Conectado.', { exact: true })).toBeVisible();
  expect(signupCalls(api)).toHaveLength(1);

  const legacy = await installApi(page, { channel: { ...CONNECTED, state: 'LEGACY' } });
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('credencial antiga do Soprei');
  await expect(page.getByRole('button', { name: 'Reconectar', exact: true })).toBeVisible();
  expect(legacy.calls.length).toBeGreaterThan(0);
});

test('cancelar o popup volta ao estado anterior sem erro; popup bloqueado tem mensagem propria', async ({
  page,
}) => {
  const api = await installApi(page);
  await page.goto('/painel/canal');
  await startConnect(page);
  await answerLogin(page, null);
  await expect(page.getByText('Conexão cancelada.')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continuar na Meta' })).toBeEnabled();

  // O evento CANCEL do popup tem o mesmo efeito.
  await page.getByRole('button', { name: 'Continuar na Meta' }).click();
  await postFromPopup(page, WWW, {
    type: 'WA_EMBEDDED_SIGNUP',
    event: 'CANCEL',
    data: { current_step: 'x' },
  });
  await expect(page.getByText('Conexão cancelada.')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);

  // Variantes do FINISH e ERROR não são suportadas: mensagem fixa, sem o texto da Meta.
  await page.getByRole('button', { name: 'Continuar na Meta' }).click();
  await postFromPopup(page, WWW, {
    type: 'WA_EMBEDDED_SIGNUP',
    event: 'FINISH_ONLY_WABA',
    data: {},
  });
  await expect(page.getByRole('alert')).toContainText('não é suportado');
  await page.getByRole('button', { name: 'Continuar na Meta' }).click();
  await postFromPopup(page, WWW, {
    type: 'WA_EMBEDDED_SIGNUP',
    event: 'ERROR',
    data: { error_message: SENTINEL },
  });
  await expect(page.getByRole('alert')).toContainText('A Meta não concluiu a conexão');
  await expect(page.locator('body')).not.toContainText(SENTINEL);

  // Popup bloqueado: `window.open` devolve null durante o clique.
  await page.evaluate(() => {
    window.open = () => null;
  });
  const next = page.getByRole('button', { name: 'Continuar na Meta' });
  await expect(next).toBeEnabled();
  await next.click();
  await expect(page.getByRole('alert')).toContainText('bloqueou a janela da Meta');
  await expect(next).toBeEnabled();
  expect(signupCalls(api)).toHaveLength(0);
});

test('erros do servidor mostram a mensagem da tabela e nunca o texto do servidor', async ({
  page,
}) => {
  const api = await installApi(page);
  await page.goto('/painel/canal');
  const cases: [number, string, string][] = [
    [409, 'CHANNEL_NUMBER_IN_USE', 'Esse número já está conectado a outra empresa.'],
    [400, 'CHANNEL_CODE_INVALID', 'A autorização expirou ou já foi usada. Tente de novo.'],
    [
      400,
      'CHANNEL_REGISTRATION_FAILED',
      'Não foi possível registrar o número na Meta. Tente de novo; se persistir, fale com o suporte.',
    ],
    [400, 'CHANNEL_TOKEN_REJECTED', 'A Meta recusou a autorização. Tente conectar de novo.'],
    [400, 'CHANNEL_WRONG_APP', 'A autorização não veio do aplicativo do Soprei.'],
    [400, 'CHANNEL_MISSING_SCOPE', 'Faltou conceder todas as permissões do WhatsApp.'],
    [400, 'CHANNEL_NUMBER_NOT_IN_WABA', 'Esse número não pertence à conta escolhida.'],
    [502, 'EXTERNAL_SERVICE_ERROR', 'A Meta ou o serviço está indisponível.'],
    [503, 'SERVICE_UNAVAILABLE', 'A Meta ou o serviço está indisponível.'],
    [429, 'RATE_LIMITED', 'Muitas tentativas. Aguarde antes de tentar novamente.'],
    [403, 'FORBIDDEN', 'Você não tem permissão para esta ação.'],
    [400, 'VALIDATION_ERROR', 'Não foi possível concluir. Tente novamente.'],
  ];
  for (const [index, [status, code, text]] of cases.entries()) {
    api.signup = { status, code };
    if (index === 0) await startConnect(page);
    else await page.getByRole('button', { name: 'Continuar na Meta' }).click();
    await answerLogin(page, `CODE-${String(index)}`);
    await postFromPopup(page, WWW, finishEvent());
    await expect(page.getByRole('alert')).toContainText(text);
    await expect(page.locator('body')).not.toContainText(SENTINEL);
    expect(signupCalls(api)).toHaveLength(index + 1);
  }
  // Cada tentativa usou o code da própria tentativa (nada foi reaproveitado).
  expect(signupCalls(api).map((call) => (call.body as { code: string }).code)).toEqual(
    cases.map((_, index) => `CODE-${String(index)}`),
  );
});

test('code com mais de 20 s sem envio e descartado sem enviar (relogio)', async ({ page }) => {
  const api = await installApi(page);
  await page.goto('/painel/canal');
  await page.getByRole('button', { name: 'Conectar com a Meta', exact: true }).click();
  const next = page.getByRole('button', { name: 'Continuar na Meta' });
  await expect(next).toBeEnabled();
  await page.clock.install();
  await next.click();
  await answerLogin(page, 'CODE-VELHO');
  await page.clock.runFor(11_000);
  await expect(page.getByRole('alert')).toContainText('Tempo esgotado');
  // Os ids chegando tarde não ressuscitam o code.
  await postFromPopup(page, WWW, finishEvent());
  expect(signupCalls(api)).toHaveLength(0);
});

test('AGENT e VIEWER nao veem as abas; forcar a URL nao chama a API de canal', async ({ page }) => {
  const agent = await installApi(page, { role: 'AGENT' });
  await page.goto('/painel/canal');
  await expect(page.getByRole('tab', { name: 'Testar' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Canal' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Persona' })).toHaveCount(0);
  await expect(page.getByText('Você não tem permissão para ver esta tela.')).toBeVisible();
  expect(channelCalls(agent)).toHaveLength(0);

  const viewer = await installApi(page, { role: 'VIEWER' });
  await page.goto('/painel/persona');
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect(page.getByText('Você não tem permissão para usar nenhuma tela')).toBeVisible();
  expect(viewer.calls.filter((call) => call.path.includes('/persona'))).toHaveLength(0);
  expect(viewer.calls.filter((call) => call.path.includes('/messages'))).toHaveLength(0);
});

test('404 de empresa muda a tela para "A empresa selecionada mudou"; 404 sem mudança é canal desabilitado', async ({
  page,
}) => {
  const first = company('Empresa A');
  const second = company('Empresa B');
  // A seleção mudou em outra aba: a leitura da sessão depois do 404 mostra a empresa B.
  const api = await installApi(page, {
    companies: [first, second],
    selected: first.companyId,
    channelNotFound: true,
    laterSelected: second.companyId,
  });
  await page.goto('/painel/canal');
  await expect(page.getByText('A empresa selecionada mudou. Escolha de novo.')).toBeVisible();
  await expect(page.getByText('Suas empresas')).toBeVisible();
  expect(api.selected).toBe(second.companyId);

  // 404 com a mesma empresa selecionada: o canal não está habilitado neste ambiente.
  const same = await installApi(page, { channelNotFound: true });
  await page.goto('/painel/canal');
  await expect(
    page.getByText('O canal do WhatsApp não está habilitado neste ambiente.'),
  ).toBeVisible();
  expect(same.calls.length).toBeGreaterThan(0);
});

test('persona: salvar, voltar ao padrao, contador e erro acessivel', async ({ page }) => {
  const api = await installApi(page);
  await page.goto('/painel/persona');
  const field = page.getByLabel('Persona do assistente');
  await expect(field).toBeEnabled();
  await field.fill('Fale com carinho.');
  await expect(page.getByText('17 de 4000 caracteres')).toBeVisible();
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.getByText('Persona salva.')).toBeVisible();
  expect(api.calls.filter((call) => call.method === 'PUT').map((call) => call.body)).toEqual([
    { persona: 'Fale com carinho.' },
  ]);
  await page.getByRole('button', { name: 'Voltar ao padrão' }).click();
  await expect(page.getByText('Persona padrão restaurada.')).toBeVisible();
  await expect(field).toHaveValue('');
  expect(api.persona).toBeNull();

  // Texto em branco não salva; o erro fica ligado ao campo por aria-describedby.
  await field.fill('   ');
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  const describedBy = await field.getAttribute('aria-describedby');
  expect(describedBy).toBeTruthy();
  const errorId = describedBy?.split(' ').find((id) => id.endsWith('-error')) ?? '';
  await expect(page.locator(`#${errorId}`)).toContainText('Escreva a persona');
  expect(api.calls.filter((call) => call.method === 'PUT')).toHaveLength(2);

  // 400 do servidor: mensagem fixa no campo, sem o texto do servidor.
  api.personaStatus = 400;
  await field.fill('Texto');
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator(`#${errorId}`)).toContainText('A persona não foi aceita');
  await expect(page.locator('body')).not.toContainText(SENTINEL);
  await expectNoSecretsStored(page, ['Texto', 'Fale com carinho.']);
});

test('testar o atendimento: envio, resposta, marca de fallback e botao desabilitado enquanto espera', async ({
  page,
}) => {
  const api = await installApi(page);
  await page.goto('/painel/testar');
  await expect(page.getByText('É um teste: a conversa fica gravada no Soprei')).toBeVisible();
  hold(api);
  await page.getByLabel('Mensagem de teste').fill('Quais são os horários?');
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Aguardando resposta…' })).toBeDisabled();
  api.release();
  await expect(page.getByText('Olá! Como posso ajudar?')).toBeVisible();
  const message = api.calls.find((call) => call.path.endsWith('/messages'));
  expect(message?.body).toEqual({ contactRef: 'teste-no-site', text: 'Quais são os horários?' });

  api.reply = { text: 'Desculpe, tente de novo.', isFallback: true };
  await page.getByLabel('Mensagem de teste').fill('Outra pergunta');
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect(page.getByText('Desculpe, tente de novo.')).toBeVisible();
  await expect(page.getByText('resposta padrão (houve falha ao gerar)')).toBeVisible();
  await expectNoSecretsStored(page, ['Quais são os horários?', 'Outra pergunta']);
});

test('resposta tardia do teste depois de trocar de empresa nao aparece na outra', async ({
  page,
}) => {
  const first = company('Empresa A');
  const second = company('Empresa B');
  const api = await installApi(page, { companies: [first, second], selected: first.companyId });
  await page.goto('/painel/testar');
  hold(api);
  api.reply = { text: 'RESPOSTA-DA-EMPRESA-A', isFallback: false };
  await page.getByLabel('Mensagem de teste').fill('Pergunta da A');
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Aguardando resposta…' })).toBeVisible();
  await page.getByRole('button', { name: 'Trocar de empresa' }).click();
  await expect(page.getByText('Suas empresas')).toBeVisible();
  await page
    .getByRole('listitem')
    .filter({ hasText: 'Empresa B' })
    .getByRole('button', { name: 'Selecionar', exact: true })
    .click();
  await page.getByRole('button', { name: 'Abrir painel' }).click();
  await page.getByRole('tab', { name: 'Testar' }).click();
  api.release();
  await page.waitForTimeout(300);
  await expect(page.getByText('RESPOSTA-DA-EMPRESA-A')).toHaveCount(0);
  await expect(page.getByText('Pergunta da A')).toHaveCount(0);
});

test('formulario avancado so aparece com a flag, limpa o token e nao o guarda', async ({
  page,
}) => {
  const api = await installApi(page, {
    setup: { embeddedSignup: null, manualConnect: true },
  });
  await page.goto('/painel/canal');
  await expect(page.getByRole('button', { name: 'Conectar com a Meta' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Avançado (testes)' }).click();
  const token = page.getByLabel('Token de acesso');
  await expect(token).toHaveAttribute('type', 'password');
  await expect(token).toHaveAttribute('autocomplete', 'off');
  await page.getByLabel('ID do número de telefone (Meta)').fill(PHONE_NUMBER_ID);
  await page.getByLabel('ID da conta do WhatsApp Business (WABA)').fill(WABA_ID);
  await token.fill('curto');
  await page.getByRole('button', { name: 'Conectar manualmente' }).click();
  await expect(page.getByText('O token tem de 20 a 1024 caracteres')).toBeVisible();
  await token.fill('EAAG-token-de-teste-1234567890');
  await page.getByRole('button', { name: 'Conectar manualmente' }).click();
  await expect(page.getByText('Conectado.', { exact: true })).toBeVisible();
  const put = api.calls.find((call) => call.method === 'PUT');
  expect(put?.body).toEqual({
    phoneNumberId: PHONE_NUMBER_ID,
    wabaId: WABA_ID,
    accessToken: 'EAAG-token-de-teste-1234567890',
  });
  expect(sdkRequests(api)).toBe(0);
  await expectNoSecretsStored(page, ['EAAG-token-de-teste-1234567890']);

  // Sem a flag e sem config_id: só a mensagem de que a conexão pelo site não está configurada.
  const bare = await installApi(page, { setup: { embeddedSignup: null, manualConnect: false } });
  await page.reload();
  await expect(page.getByText('A conexão pelo site ainda não está configurada.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Avançado (testes)' })).toHaveCount(0);
  expect(bare.calls.length).toBeGreaterThan(0);
});

test('foco por teclado percorre o menu da empresa e a ordem de tabulacao e natural', async ({
  page,
}) => {
  await installApi(page, { channel: NOT_CONNECTED });
  await page.goto('/painel/canal');
  await expect(page.getByRole('tab', { name: 'Canal' })).toBeVisible();
  await page.getByRole('button', { name: 'Trocar de empresa' }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('tab', { name: 'Canal' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Persona' })).toBeFocused();
});
