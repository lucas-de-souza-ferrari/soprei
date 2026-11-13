import { expect, test, type Page } from '@playwright/test';
import { buildPdf, DRAWING_ONLY, textContent } from './file-builders';
import { holdPdfWorker, openKnowledge, type FakeKnowledge } from './knowledge-fixture';

/** Spec 040: ler PDF (e DOCX, na E2) no navegador, na aba Conhecimento. */

const MESSAGES = {
  noText: 'Não encontramos texto neste arquivo.',
  password: 'Este PDF está protegido por senha.',
  unreadable: 'Não foi possível ler este arquivo.',
  notPdf: 'Este arquivo não é um PDF válido.',
  tooBig: 'O arquivo passa de 10 MB.',
  loader: 'Não foi possível carregar o leitor de arquivos.',
};
const READER_REQUEST = /pdf-text|pdfjs|pdf\.worker/;

const fileInput = (page: Page) => page.getByLabel('Ou escolha um arquivo (texto, PDF ou Word)');
const textArea = (page: Page) => page.getByLabel('Texto do documento');
const titleInput = (page: Page) => page.getByLabel('Título do documento');
const fileError = (page: Page) => page.locator('#arquivo-do-documento-erro');

async function choose(page: Page, name: string, buffer: Buffer, mimeType = 'application/pdf') {
  await fileInput(page).setInputFiles({ name, mimeType, buffer });
}

async function ready(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Adicionar documento' })).toBeVisible();
}

const twoPages = (): Buffer =>
  buildPdf({
    pages: [
      textContent(['Política de trocas', 'Trocas em até 7 dias com a nota.']),
      textContent(['Horário de funcionamento', 'Segunda a sexta, das 9h às 18h.']),
    ],
  });

async function noHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

function expectNoForeign(knowledge: FakeKnowledge): void {
  expect(knowledge.foreign).toEqual([]);
}

for (const theme of ['light', 'dark'] as const) {
  test(`PDF de duas páginas preenche o texto, sugere o título e é enviado pela rota de sempre (tema ${theme})`, async ({
    page,
  }) => {
    const { knowledge } = await openKnowledge(page, theme);
    await ready(page);
    await expect(fileInput(page)).toHaveAttribute('accept', /\.pdf/);
    await choose(page, 'Politica_de-trocas.pdf', twoPages());

    await expect(textArea(page)).toHaveValue(/Política de trocas/);
    const content = await textArea(page).inputValue();
    expect(content).toContain('Trocas em até 7 dias com a nota.');
    expect(content).toContain('Horário de funcionamento');
    expect(content).toContain('Segunda a sexta, das 9h às 18h.');
    // Páginas separadas por linha em branco.
    expect(content).toMatch(/nota\.\n\nHorário/);
    await expect(titleInput(page)).toHaveValue('Politica de trocas');
    await expect(
      page.getByText(
        `Texto lido do arquivo: ${content.length.toLocaleString('pt-BR')} caracteres.`,
      ),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Adicionar', exact: true }).click();
    await expect(page.getByText('Documento adicionado. A IA já pode usá-lo.')).toBeVisible();
    expect(knowledge.posts).toEqual([{ title: 'Politica de trocas', content }]);
    expectNoForeign(knowledge);
  });
}

test('"Lendo arquivo…" com o worker atrasado; outro arquivo nesse intervalo faz valer só o segundo', async ({
  page,
}) => {
  const { knowledge } = await openKnowledge(page);
  await ready(page);
  const worker = await holdPdfWorker(page);
  await choose(page, 'primeiro.pdf', buildPdf({ pages: [textContent(['PRIMEIRO-ARQUIVO'])] }));
  await expect(page.getByText('Lendo arquivo…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancelar leitura' })).toBeVisible();
  await expect(textArea(page)).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Adicionar', exact: true })).toBeDisabled();
  await expect(fileInput(page)).toBeEnabled();
  await expect.poll(worker.held).toBe(true);

  await choose(page, 'segundo.pdf', buildPdf({ pages: [textContent(['Segundo arquivo'])] }));
  await expect(textArea(page)).toHaveValue('Segundo arquivo');
  await expect(titleInput(page)).toHaveValue('segundo');
  worker.release();
  // O primeiro (atrasado) nunca preenche o formulário.
  await page.waitForTimeout(500);
  await expect(textArea(page)).toHaveValue('Segundo arquivo');
  await expect(page.getByText('Lendo arquivo…')).toHaveCount(0);
  expectNoForeign(knowledge);
});

test('"Cancelar leitura" volta a tela ao estado anterior, sem erro', async ({ page }) => {
  await openKnowledge(page);
  await ready(page);
  await textArea(page).fill('Texto que já estava');
  const worker = await holdPdfWorker(page);
  await choose(page, 'lento.pdf', buildPdf({ pages: [textContent(['NAO-DEVE-APARECER'])] }));
  await expect(page.getByText('Lendo arquivo…')).toBeVisible();
  await page.getByRole('button', { name: 'Cancelar leitura' }).click();
  await expect(page.getByText('Lendo arquivo…')).toHaveCount(0);
  await expect(textArea(page)).toBeEnabled();
  await expect(textArea(page)).toHaveValue('Texto que já estava');
  await expect(fileError(page)).toHaveCount(0);
  expect(await fileInput(page).inputValue()).toBe('');
  worker.release();
  await page.waitForTimeout(500);
  await expect(textArea(page)).toHaveValue('Texto que já estava');
  await expect(fileError(page)).toHaveCount(0);
});

test('PDF sem texto, com senha, truncado, texto renomeado e grande demais têm mensagens próprias', async ({
  page,
}) => {
  const { knowledge } = await openKnowledge(page);
  await ready(page);

  // Arquivo grande demais: recusado antes de carregar o leitor.
  await choose(page, 'enorme.pdf', Buffer.alloc(10 * 1024 * 1024 + 1, 0x20));
  await expect(fileError(page)).toContainText(MESSAGES.tooBig);
  expect(knowledge.requested.filter((url) => READER_REQUEST.test(url))).toEqual([]);

  await choose(page, 'renomeado.pdf', Buffer.from('só um texto qualquer', 'utf8'));
  await expect(fileError(page)).toContainText(MESSAGES.notPdf);
  expect(knowledge.requested.filter((url) => READER_REQUEST.test(url))).toEqual([]);

  await choose(page, 'desenho.pdf', buildPdf({ pages: [DRAWING_ONLY] }));
  await expect(fileError(page)).toContainText(MESSAGES.noText);

  await choose(
    page,
    'senha.pdf',
    buildPdf({ pages: [textContent(['Conteudo protegido'])], userPassword: 'segredo' }),
  );
  await expect(fileError(page)).toContainText(MESSAGES.password);

  const whole = twoPages();
  await choose(page, 'truncado.pdf', whole.subarray(0, 40));
  await expect(fileError(page)).toContainText(MESSAGES.unreadable);

  await expect(textArea(page)).toHaveValue('');
  expect(knowledge.posts).toEqual([]);
  expectNoForeign(knowledge);
});

test('leitor bloqueado mostra "Não foi possível carregar o leitor de arquivos"', async ({
  page,
}) => {
  await openKnowledge(page);
  await ready(page);
  await page.route(/pdf-text/, (route) => route.abort());
  await choose(page, 'politica.pdf', twoPages());
  await expect(fileError(page)).toContainText(MESSAGES.loader);
  await expect(textArea(page)).toHaveValue('');
});

test('privacidade: a frase secreta do PDF não vai ao console, ao armazenamento, à URL nem a outro host', async ({
  page,
}) => {
  const secret = 'FRASE-SECRETA-DO-ARQUIVO-040';
  const { knowledge } = await openKnowledge(page);
  await ready(page);
  const url = page.url();
  const title = await page.title();
  await choose(
    page,
    'segredo.pdf',
    buildPdf({ pages: [textContent([`Senha do cofre ${secret}`])] }),
  );
  await expect(textArea(page)).toHaveValue(new RegExp(secret));
  await page.getByRole('button', { name: 'Adicionar', exact: true }).click();
  await expect(page.getByText('Documento adicionado. A IA já pode usá-lo.')).toBeVisible();

  expect(knowledge.console.filter((line) => line.includes(secret))).toEqual([]);
  const storage = await page.evaluate(() => ({
    local: Object.keys(localStorage),
    session: sessionStorage.length,
  }));
  expect(storage.local).toEqual(['soprei-theme']);
  expect(storage.session).toBe(0);
  expect(page.url()).toBe(url);
  expect(await page.title()).toBe(title);
  expect(knowledge.requested.filter((item) => item.includes(secret))).toEqual([]);
  expectNoForeign(knowledge);
});

test('.txt continua como antes e a tela a 360 px não rola na horizontal', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const { knowledge } = await openKnowledge(page);
  await ready(page);
  await choose(page, 'horarios.txt', Buffer.from('Abrimos às 9h.', 'utf8'), 'text/plain');
  await expect(textArea(page)).toHaveValue('Abrimos às 9h.');
  await expect(titleInput(page)).toHaveValue('horarios');
  await expect(page.getByText(/Texto lido do arquivo/)).toHaveCount(0);
  expect(knowledge.requested.filter((url) => READER_REQUEST.test(url))).toEqual([]);

  await titleInput(page).fill('');
  const worker = await holdPdfWorker(page);
  await choose(page, 'politica.pdf', twoPages());
  await expect(page.getByText('Lendo arquivo…')).toBeVisible();
  await noHorizontalScroll(page);
  worker.release();
  await expect(page.getByText(/Texto lido do arquivo/)).toBeVisible();
  await noHorizontalScroll(page);
});
