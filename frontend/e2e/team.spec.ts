import { expect, test, type Page } from '@playwright/test';
import {
  company,
  goTo,
  installApi,
  menuItems,
  SENTINEL,
  switchTo,
  type FakeApi,
  type Role,
} from './company-fixture';
import {
  holdMembers,
  installTeamApi,
  invitation,
  newTeam,
  person,
  type FakeTeam,
} from './team-fixture';

/** Abre `/painel/equipe` como o papel dado, com a equipe semeada (o próprio vínculo vem primeiro). */
async function open(
  page: Page,
  role: Role,
  seed: (api: FakeApi, team: FakeTeam, self: ReturnType<typeof person>) => void = () => undefined,
  theme: 'light' | 'dark' = 'light',
): Promise<{ api: FakeApi; team: FakeTeam; self: ReturnType<typeof person> }> {
  await page.addInitScript((value) => localStorage.setItem('soprei-theme', value), theme);
  const api = await installApi(page, { role });
  const team = newTeam();
  await installTeamApi(page, api, team);
  const current = api.companies[0];
  if (current === undefined) throw new Error('empresa da fixture');
  const self = person('eu@example.test', role, { id: current.membershipId });
  team.members[current.companyId] = [self];
  team.invitations[current.companyId] = [];
  seed(api, team, self);
  await page.goto('/painel/equipe');
  return { api, team, self };
}

const companyIdOf = (api: FakeApi): string => api.companies[0]?.companyId ?? '';
const rows = (page: Page, kind: 'membro' | 'convite') => page.getByTestId(kind);

async function noHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

for (const theme of ['light', 'dark'] as const) {
  test(`lista de membros e de convites, "você", selos de texto e menu na ordem (tema ${theme})`, async ({
    page,
  }, testInfo) => {
    const { api } = await open(
      page,
      'OWNER',
      (api, team) => {
        const id = companyIdOf(api);
        team.members[id]?.push(
          person('ana@example.test', 'ADMIN'),
          person('bia@example.test', 'AGENT', { status: 'DISABLED' }),
        );
        team.invitations[id] = [
          invitation('novo@example.test', 'VIEWER'),
          invitation('velho@example.test', 'AGENT', { state: 'EXPIRED' }),
        ];
      },
      theme,
    );
    const items = await menuItems(page);
    for (const label of ['Conversas', 'Canal', 'Persona', 'Equipe', 'Testar']) {
      expect(items).toContain(label);
    }
    expect(items.indexOf('Persona')).toBeLessThan(items.indexOf('Equipe'));
    expect(items.indexOf('Equipe')).toBeLessThan(items.indexOf('Testar'));

    await expect(rows(page, 'membro')).toHaveCount(3);
    await expect(rows(page, 'membro').first()).toContainText('eu@example.test');
    await expect(rows(page, 'membro').first()).toContainText('(você)');
    await expect(rows(page, 'membro').nth(1)).toContainText('Administrador');
    await expect(rows(page, 'membro').nth(1)).toContainText('Ativo');
    await expect(rows(page, 'membro').nth(2)).toContainText('Desativado');
    await expect(rows(page, 'membro').nth(2)).toContainText('Desde');
    await expect(rows(page, 'convite')).toHaveCount(2);
    await expect(rows(page, 'convite').first()).toContainText('Pendente');
    await expect(rows(page, 'convite').first()).toContainText('Enviado em');
    await expect(rows(page, 'convite').first()).toContainText('Vence em');
    await expect(rows(page, 'convite').nth(1)).toContainText('Vencido');
    await expect(rows(page, 'convite').nth(1)).toContainText('Venceu em');
    await noHorizontalScroll(page);
    expect(api.external.filter((url) => !url.includes('fonts.g'))).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`equipe-${theme}.png`), fullPage: true });
  });
}

test('estado vazio: a única pessoa da equipe é convidada a convidar alguém', async ({ page }) => {
  await open(page, 'OWNER');
  await expect(
    page.getByText('Você ainda é a única pessoa da equipe. Convide alguém.'),
  ).toBeVisible();
});

test('carregando e erro com "Tentar de novo"', async ({ page }) => {
  const { team } = await open(page, 'OWNER', (_api, team) => {
    team.failMembers = true;
  });
  await expect(page.getByRole('alert')).toContainText(
    'Não foi possível concluir. Tente novamente.',
  );
  await expect(page.getByText(SENTINEL)).toHaveCount(0);
  team.failMembers = false;
  await page.getByRole('button', { name: 'Tentar de novo' }).click();
  await expect(rows(page, 'membro')).toHaveCount(1);
});

test('paginação: "Carregar mais membros" acrescenta a próxima página sem repetir', async ({
  page,
}) => {
  await open(page, 'OWNER', (api, team) => {
    const id = companyIdOf(api);
    for (let index = 0; index < 34; index += 1) {
      team.members[id]?.push(person(`p${String(index)}@example.test`, 'VIEWER'));
    }
  });
  await expect(rows(page, 'membro')).toHaveCount(30);
  await page.getByRole('button', { name: 'Carregar mais membros' }).click();
  await expect(rows(page, 'membro')).toHaveCount(35);
  await expect(page.getByRole('button', { name: 'Carregar mais membros' })).toHaveCount(0);
});

test.describe('convidar', () => {
  test('sucesso: mensagem fixa, a pessoa entra na lista de convites e o formulário limpa', async ({
    page,
  }) => {
    const { team } = await open(page, 'OWNER');
    await page.getByLabel('E-mail da pessoa').fill('  Nova@Example.test ');
    await expect(page.getByText('O link será enviado para')).toContainText('Nova@Example.test');
    await page.getByLabel('Papel', { exact: true }).selectOption('VIEWER');
    await page.getByRole('button', { name: 'Enviar convite' }).click();
    await expect(
      page.getByText('Convite criado. Enviamos o link para o e-mail informado.'),
    ).toBeVisible();
    await expect(rows(page, 'convite')).toHaveCount(1);
    await expect(rows(page, 'convite').first()).toContainText('nova@example.test');
    await expect(rows(page, 'convite').first()).toContainText('Somente leitura');
    await expect(page.getByLabel('E-mail da pessoa')).toHaveValue('');
    const post = team.calls.find((call) => call.method === 'POST');
    expect(post?.body).toEqual({ email: 'nova@example.test', role: 'VIEWER' });
  });

  test('e-mail inválido é recusado na tela, sem chamar a API', async ({ page }) => {
    const { team } = await open(page, 'OWNER');
    await expect(rows(page, 'membro')).toHaveCount(1);
    const before = team.calls.length;
    await page.getByLabel('E-mail da pessoa').fill('isto-nao-e-email');
    await page.getByRole('button', { name: 'Enviar convite' }).click();
    await expect(page.getByText('Informe um e-mail válido.')).toBeVisible();
    expect(team.calls.length).toBe(before);
  });

  for (const [status, code, message] of [
    [409, 'MEMBER_ALREADY_EXISTS', 'Essa pessoa já faz parte da equipe.'],
    [
      409,
      'INVITATION_ALREADY_PENDING',
      'Já existe um convite pendente para este e-mail. Use "Reenviar" na lista de convites.',
    ],
    [429, 'INVITATION_LIMIT_REACHED', 'Limite de convites atingido. Tente novamente mais tarde.'],
    [403, 'FORBIDDEN', 'Você não tem permissão para esta ação.'],
    [
      503,
      'SERVICE_UNAVAILABLE',
      'A Meta ou o serviço está indisponível. Tente novamente em instantes.',
    ],
    [500, 'INTERNAL_ERROR', 'Não foi possível concluir. Tente novamente.'],
  ] as const) {
    test(`erro ${String(status)} ${code}: mensagem pelo code, nunca pelo texto do servidor`, async ({
      page,
    }) => {
      await open(page, 'OWNER', (_api, team) => {
        team.inviteError = { status, code };
      });
      await page.getByLabel('E-mail da pessoa').fill('alguem@example.test');
      await page.getByRole('button', { name: 'Enviar convite' }).click();
      await expect(page.getByRole('alert')).toContainText(message);
      await expect(page.getByText(SENTINEL)).toHaveCount(0);
    });
  }

  for (const [role, expected] of [
    ['OWNER', ['Administrador', 'Atendente', 'Somente leitura']],
    ['ADMIN', ['Atendente', 'Somente leitura']],
  ] as const) {
    test(`os papéis oferecidos dependem de quem convida: ${role}`, async ({ page }) => {
      await open(page, role);
      await expect(page.getByLabel('Papel', { exact: true })).toBeVisible();
      const options = await page
        .getByLabel('Papel', { exact: true })
        .locator('option')
        .allTextContents();
      expect(options).toEqual([...expected]);
    });
  }
});

test('reenviar: desabilitado com a contagem dentro do intervalo, libera depois e mostra o limite pelo code', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-11-04T12:00:00Z') });
  const { team } = await open(page, 'OWNER', (api, team) => {
    team.invitations[companyIdOf(api)] = [
      invitation('espera@example.test', 'AGENT', { lastSentAt: '2026-11-04T11:59:30.000Z' }),
    ];
  });
  const resend = page.getByRole('button', { name: /^Reenviar/ });
  await expect(resend).toBeDisabled();
  await expect(resend).toContainText('Reenviar (30 s)');
  await page.clock.fastForward(31_000);
  await expect(resend).toBeEnabled();
  await expect(resend).toHaveText('Reenviar');
  team.resendError = { status: 429, code: 'INVITATION_LIMIT_REACHED' };
  await resend.click();
  await expect(page.getByRole('alert')).toContainText('Limite de convites atingido.');
  team.resendError = null;
  team.clockMs = Date.parse('2026-11-04T12:00:31Z');
  await resend.click();
  await expect(page.getByText('Convite reenviado.')).toBeVisible();
  // Depois do reenvio a contagem recomeça.
  await expect(page.getByRole('button', { name: /^Reenviar/ })).toBeDisabled();
});

test('revogar e desativar usam <dialog>: foco no botão seguro, Esc cancela e o foco volta ao gatilho', async ({
  page,
}) => {
  const { team } = await open(page, 'OWNER', (api, team) => {
    const id = companyIdOf(api);
    team.members[id]?.push(person('ana@example.test', 'AGENT'));
    team.invitations[id] = [invitation('pend@example.test')];
  });
  const revoke = page.getByRole('button', { name: 'Revogar' });
  await revoke.focus();
  await revoke.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('O link enviado para pend@example.test deixa de funcionar.');
  await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(revoke).toBeFocused();
  expect(team.calls.some((call) => call.method === 'DELETE')).toBe(false);

  await revoke.click();
  await dialog.getByRole('button', { name: 'Revogar', exact: true }).click();
  await expect(rows(page, 'convite')).toHaveCount(0);
  expect(team.calls.some((call) => call.method === 'DELETE')).toBe(true);

  const disable = page.getByRole('button', { name: 'Desativar' });
  await disable.click();
  await expect(dialog).toContainText('ana@example.test perde o acesso na próxima ação.');
  await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(disable).toBeFocused();
  await disable.click();
  await dialog.getByRole('button', { name: 'Desativar', exact: true }).click();
  await expect(rows(page, 'membro').nth(1)).toContainText('Desativado');
  await expect(page.getByRole('button', { name: 'Reativar' })).toBeVisible();
  await page.getByRole('button', { name: 'Reativar' }).click();
  await expect(rows(page, 'membro').nth(1)).toContainText('Ativo');
});

test('mudar papel: Atendente é direto; Administrador pede confirmação; LAST_OWNER mostra a mensagem pelo code', async ({
  page,
}) => {
  const { team } = await open(page, 'OWNER', (api, team) => {
    const id = companyIdOf(api);
    team.members[id]?.push(
      person('ana@example.test', 'AGENT'),
      person('adm@example.test', 'ADMIN'),
    );
  });
  await page.getByLabel('Papel de ana@example.test').selectOption('VIEWER');
  await expect(rows(page, 'membro').nth(1)).toContainText('Somente leitura');
  expect(team.calls.some((call) => call.method === 'PATCH')).toBe(true);

  const adminSelect = page.getByLabel('Papel de adm@example.test');
  await adminSelect.selectOption('AGENT');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('adm@example.test passa de Administrador para Atendente.');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(rows(page, 'membro').nth(2)).toContainText('Administrador');

  team.patchError = { status: 409, code: 'LAST_OWNER' };
  await adminSelect.selectOption('AGENT');
  await dialog.getByRole('button', { name: 'Mudar papel' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'A empresa precisa ter ao menos um proprietário ativo.',
  );
  await expect(page.getByText(SENTINEL)).toHaveCount(0);
});

test('hierarquia: ADMIN não vê ações sobre OWNER, outro ADMIN nem sobre si; OWNER não vê ações na própria linha', async ({
  page,
}) => {
  await open(page, 'ADMIN', (api, team) => {
    const id = companyIdOf(api);
    team.members[id]?.push(
      person('dono@example.test', 'OWNER'),
      person('outro-adm@example.test', 'ADMIN'),
      person('atendente@example.test', 'AGENT'),
    );
  });
  const controls = (email: string) =>
    rows(page, 'membro').filter({ hasText: email }).getByRole('button');
  await expect(controls('eu@example.test')).toHaveCount(0);
  await expect(controls('dono@example.test')).toHaveCount(0);
  await expect(controls('outro-adm@example.test')).toHaveCount(0);
  await expect(controls('atendente@example.test')).toHaveCount(1);
  await expect(page.getByLabel('Papel de dono@example.test')).toHaveCount(0);
  await expect(page.getByLabel('Papel de atendente@example.test')).toHaveCount(1);
});

test('hierarquia do OWNER: sem ações na própria linha e com ações sobre todos os outros', async ({
  page,
}) => {
  await open(page, 'OWNER', (api, team) => {
    team.members[companyIdOf(api)]?.push(person('dono2@example.test', 'OWNER'));
  });
  await expect(
    rows(page, 'membro').filter({ hasText: 'eu@example.test' }).getByRole('button'),
  ).toHaveCount(0);
  await expect(page.getByLabel('Papel de dono2@example.test')).toHaveCount(1);
});

for (const role of ['AGENT', 'VIEWER'] as const) {
  test(`${role}: não vê a aba Equipe e a URL forçada mostra "sem permissão" sem chamar a API`, async ({
    page,
  }) => {
    const { team } = await open(page, role);
    expect(await menuItems(page)).not.toContain('Equipe');
    await expect(page.getByText('Você não tem permissão para ver esta tela.')).toBeVisible();
    expect(team.calls).toEqual([]);
  });
}

test('trocar de empresa durante o carregamento: a resposta tardia da outra empresa não aparece', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('soprei-theme', 'light'));
  const api = await installApi(page, { role: 'OWNER' });
  const first = api.companies[0];
  const second = company('Empresa B', 'OWNER');
  api.companies.push(second);
  if (first === undefined) throw new Error('empresa da fixture');
  const team = newTeam();
  await installTeamApi(page, api, team);
  team.members[first.companyId] = [
    person('eu@example.test', 'OWNER', { id: first.membershipId }),
    person('so-da-empresa-a@example.test', 'AGENT'),
  ];
  team.members[second.companyId] = [
    person('eu@example.test', 'OWNER', { id: second.membershipId }),
    person('so-da-empresa-b@example.test', 'AGENT'),
  ];
  holdMembers(team, first.companyId);
  await page.goto('/painel/equipe');
  await expect(page.getByText('Carregando a equipe…')).toBeVisible();
  // Troca para a empresa B enquanto a leitura da A está presa.
  await switchTo(page, 'Empresa B');
  await goTo(page, 'Equipe');
  await expect(page.locator('strong', { hasText: 'so-da-empresa-b@example.test' })).toBeVisible();
  team.release();
  await page.waitForTimeout(150);
  await expect(page.getByText('so-da-empresa-a@example.test')).toHaveCount(0);
  await expect(page.locator('strong', { hasText: 'so-da-empresa-b@example.test' })).toBeVisible();
});

test('nenhuma requisição fora de /api e nenhum texto do servidor em respostas de erro', async ({
  page,
}) => {
  const { api } = await open(page, 'OWNER', (_api, team) => {
    team.patchError = { status: 500, code: 'INTERNAL_ERROR' };
  });
  await expect(page.getByText(SENTINEL)).toHaveCount(0);
  expect(api.external.filter((url) => !url.includes('fonts.g'))).toEqual([]);
});
