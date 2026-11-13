import { expect, test, type Page } from '@playwright/test';
import {
  buildDocx,
  buildPdf,
  buildZip,
  docxEntries,
  DRAWING_ONLY,
  oleFile,
  textContent,
} from './file-builders';
import {
  holdDocxWorker,
  holdPdfWorker,
  openKnowledge,
  type FakeKnowledge,
} from './knowledge-fixture';

/** Spec 040: ler PDF e DOCX no navegador, na aba Conhecimento. */

const MESSAGES = {
  noText: 'Não encontramos texto neste arquivo.',
  password: 'Este PDF está protegido por senha.',
  unreadable: 'Não foi possível ler este arquivo.',
  notPdf: 'Este arquivo não é um PDF válido.',
  tooBig: 'O arquivo passa de 10 MB.',
  loader: 'Não foi possível carregar o leitor de arquivos.',
  notDocx: 'Este arquivo não é um documento do Word (.docx) válido.',
  docxProtected: 'Este documento do Word está protegido por senha ou em formato antigo.',
  docLegacy: 'Arquivos .doc antigos não são aceitos.',
  odt: 'Arquivos .odt não são aceitos.',
};
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
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

// --- E2: DOCX ---

test('DOCX com dois parágrafos preenche o texto com linha em branco e sugere o título sem .docx', async ({
  page,
}) => {
  const { knowledge } = await openKnowledge(page);
  await ready(page);
  await choose(
    page,
    'Perguntas_frequentes.docx',
    buildDocx(['Entregamos em todo o bairro.', 'Pagamento por Pix ou cartão.']),
    DOCX_MIME,
  );
  await expect(textArea(page)).toHaveValue(
    'Entregamos em todo o bairro.\n\nPagamento por Pix ou cartão.',
  );
  await expect(titleInput(page)).toHaveValue('Perguntas frequentes');
  await expect(page.getByText(/Texto lido do arquivo: 58 caracteres\./)).toBeVisible();
  await page.getByRole('button', { name: 'Adicionar', exact: true }).click();
  await expect(page.getByText('Documento adicionado. A IA já pode usá-lo.')).toBeVisible();
  expect(knowledge.posts).toEqual([
    {
      title: 'Perguntas frequentes',
      content: 'Entregamos em todo o bairro.\n\nPagamento por Pix ou cartão.',
    },
  ]);
  expectNoForeign(knowledge);
});

test('ZIP sem document.xml, cabeçalho OLE, DOCX sem texto, .doc e .odt têm mensagens próprias', async ({
  page,
}) => {
  const { knowledge } = await openKnowledge(page);
  await ready(page);
  const withoutDocument = buildZip(
    docxEntries(['x']).filter((entry) => entry.name !== 'word/document.xml'),
  );
  await choose(page, 'planilha.docx', withoutDocument, DOCX_MIME);
  await expect(fileError(page)).toContainText(MESSAGES.notDocx);
  await choose(page, 'protegido.docx', oleFile(), DOCX_MIME);
  await expect(fileError(page)).toContainText(MESSAGES.docxProtected);
  // Até aqui nada carregou o leitor de DOCX.
  expect(knowledge.requested.filter((url) => /docx-text|mammoth/.test(url))).toEqual([]);
  await choose(page, 'vazio.docx', buildDocx([]), DOCX_MIME);
  await expect(fileError(page)).toContainText(MESSAGES.noText);
  await choose(page, 'antigo.doc', oleFile(), 'application/msword');
  await expect(fileError(page)).toContainText(MESSAGES.docLegacy);
  await choose(page, 'libre.odt', buildZip([{ name: 'mimetype', data: 'x' }]), 'application/zip');
  await expect(fileError(page)).toContainText(MESSAGES.odt);
  await expect(textArea(page)).toHaveValue('');
  expectNoForeign(knowledge);
});

test('trocar de arquivo durante a leitura de um DOCX faz valer só o segundo', async ({ page }) => {
  const { knowledge } = await openKnowledge(page);
  await ready(page);
  const worker = await holdDocxWorker(page);
  await choose(page, 'primeiro.docx', buildDocx(['PRIMEIRO-ARQUIVO']), DOCX_MIME);
  await expect(page.getByText('Lendo arquivo…')).toBeVisible();
  await expect.poll(worker.held).toBe(true);
  await choose(page, 'segundo.docx', buildDocx(['Segundo arquivo']), DOCX_MIME);
  await expect(textArea(page)).toHaveValue('Segundo arquivo');
  await expect(titleInput(page)).toHaveValue('segundo');
  worker.release();
  await page.waitForTimeout(500);
  await expect(textArea(page)).toHaveValue('Segundo arquivo');
  await expect(page.getByText('Lendo arquivo…')).toHaveCount(0);
  expectNoForeign(knowledge);
});

test('privacidade do DOCX: a frase secreta não vai ao console, ao armazenamento, à URL nem a outro host', async ({
  page,
}) => {
  const secret = 'FRASE-SECRETA-DO-DOCX-040';
  const { knowledge } = await openKnowledge(page);
  await ready(page);
  const url = page.url();
  const title = await page.title();
  await choose(page, 'segredo.docx', buildDocx([`Código do cofre ${secret}`]), DOCX_MIME);
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
