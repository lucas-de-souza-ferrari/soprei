import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildZip, docxEntries } from '../../e2e/file-builders';
import { KNOWLEDGE_FILE_MAX_BYTES } from './knowledge-api';
import {
  type ExtractResult,
  type Extractor,
  type FileLike,
  FileReadController,
  type ReadOutcome,
} from './knowledge-file-reader';
import {
  checkFileSizeFor,
  checkMagicBytes,
  detectFileKind,
  docxZipProblem,
  extractedTextProblem,
  joinPdfTextItems,
  KNOWLEDGE_BINARY_FILE_MAX_BYTES,
  KNOWLEDGE_DOCX_MAX_UNCOMPRESSED_BYTES,
  normalizeExtractedText,
  type PdfTextItem,
  readZipDirectory,
} from './knowledge-file-rules';
import { FILE_PROBLEM_MESSAGES, titleFromFileName } from './knowledge-rules';
import { canInflateRaw, inflatedSizeWithin } from './zip-inflate-guard';

/** Lê o `Blob` de verdade do arquivo falso (ou o pedaço já cortado). */
const readFake = (input: Blob | FileLike): Promise<ArrayBuffer> =>
  ('blob' in input ? (input as { blob: Blob }).blob : (input as Blob)).arrayBuffer();

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

test('detectFileKind: texto, PDF e DOCX em qualquer caixa; .doc, .odt e outros recusados', () => {
  for (const name of ['a.txt', 'A.TXT', 'b.md', 'b.MD', 'c.markdown', 'c.Markdown']) {
    assert.deepEqual(detectFileKind(name), { kind: 'text' }, name);
  }
  assert.deepEqual(detectFileKind('Politica.pdf'), { kind: 'pdf' });
  assert.deepEqual(detectFileKind('Politica.PDF'), { kind: 'pdf' });
  assert.deepEqual(detectFileKind('cardapio.docx'), { kind: 'docx' });
  assert.deepEqual(detectFileKind('cardapio.DOCX'), { kind: 'docx' });
  assert.deepEqual(detectFileKind('antigo.doc'), { problem: 'doc-legacy' });
  assert.deepEqual(detectFileKind('antigo.DOC'), { problem: 'doc-legacy' });
  assert.deepEqual(detectFileKind('libre.odt'), { problem: 'odt' });
  for (const name of ['planilha.xlsx', 'foto.png', 'sem-extensao', 'pdf', 'arquivo.pdf.exe']) {
    assert.deepEqual(detectFileKind(name), { problem: 'wrong-type' }, name);
  }
});

test('tamanho antes de ler: texto até 200 KB, PDF e DOCX até 10 MB, 0 byte é vazio', () => {
  assert.equal(checkFileSizeFor('text', KNOWLEDGE_FILE_MAX_BYTES), null);
  assert.equal(checkFileSizeFor('text', KNOWLEDGE_FILE_MAX_BYTES + 1), 'too-large');
  assert.equal(KNOWLEDGE_BINARY_FILE_MAX_BYTES, 10 * 1024 * 1024);
  for (const kind of ['pdf', 'docx'] as const) {
    assert.equal(checkFileSizeFor(kind, KNOWLEDGE_BINARY_FILE_MAX_BYTES), null);
    assert.equal(checkFileSizeFor(kind, KNOWLEDGE_BINARY_FILE_MAX_BYTES + 1), 'binary-too-large');
    assert.equal(checkFileSizeFor(kind, 0), 'empty');
  }
  assert.equal(checkFileSizeFor('text', 0), 'empty');
});

test('assinatura: %PDF- até o byte 1.024, ZIP no DOCX, OLE é "protegido ou antigo"', () => {
  assert.equal(checkMagicBytes('pdf', ascii('%PDF-1.7\n')), null);
  const late = new Uint8Array(1024);
  late.set(ascii('%PDF-'), 1000);
  assert.equal(checkMagicBytes('pdf', late), null);
  const tooLate = new Uint8Array(2048);
  tooLate.set(ascii('%PDF-'), 1020); // passa do byte 1.024
  assert.equal(checkMagicBytes('pdf', tooLate), 'not-pdf');
  assert.equal(checkMagicBytes('pdf', ascii('texto qualquer')), 'not-pdf');
  assert.equal(checkMagicBytes('docx', bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0)), null);
  assert.equal(
    checkMagicBytes('docx', bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0)),
    'docx-protected',
  );
  assert.equal(checkMagicBytes('docx', ascii('texto qualquer')), 'not-docx');
  assert.equal(checkMagicBytes('docx', bytes(0x50, 0x4b)), 'not-docx');
  assert.equal(checkMagicBytes('text', ascii('qualquer')), null);
});

test('normalizeExtractedText: vetores fixos, idempotente e sem NUL', () => {
  const vectors: [string, string][] = [
    ['égua', 'égua'], // NFC
    ['a\r\nb\rc', 'a\nb\nc'],
    ['a\tb', 'a b'],
    ['a\u0000b\u0007c\u001Bd\u0085e\u009Ff\u007F', 'abcdef'],
    ['de�volu­ção', 'devolução'],
    ['tro​cas‌‍⁠﻿', 'trocas'],
    ['muitos     espaços  aqui', 'muitos espaços aqui'],
    ['  linha com borda  \n  outra  ', 'linha com borda\noutra'],
    ['a\n\n\n\n\nb', 'a\n\nb'],
    ['\n\n  texto  \n\n', 'texto'],
    // A remoção do invisível não deixa a sequência fora da forma NFC.
    ['e​́', 'é'],
  ];
  for (const [input, expected] of vectors) {
    const once = normalizeExtractedText(input);
    assert.equal(once, expected, JSON.stringify(input));
    assert.equal(normalizeExtractedText(once), once, `idempotente: ${JSON.stringify(input)}`);
    assert.ok(!once.includes('\u0000'));
  }
  let all = '';
  for (let code = 0; code < 0x300; code++) all += String.fromCharCode(code);
  const normalized = normalizeExtractedText(all + '​�');
  assert.ok(!normalized.includes('\u0000'));
  assert.equal(normalizeExtractedText(normalized), normalized);
});

test('extractedTextProblem: sem letra nem dígito é "sem texto"; 100.000 passa, 100.001 recusa', () => {
  assert.equal(extractedTextProblem(''), 'no-text');
  assert.equal(extractedTextProblem('  . , ; — !? \n\n ...'), 'no-text');
  assert.equal(extractedTextProblem('7'), null);
  assert.equal(extractedTextProblem('ação'), null);
  assert.equal(extractedTextProblem('a'.repeat(100_000)), null);
  assert.equal(extractedTextProblem('a'.repeat(100_001)), 'content-too-large');
});

test('joinPdfTextItems: hasEOL vira quebra, páginas com linha em branco, para ao passar do limite', () => {
  const page = (...items: PdfTextItem[]): PdfTextItem[] => items;
  const joined = joinPdfTextItems([
    page(
      { str: 'Trocas em', hasEOL: false },
      { str: ' 7 dias', hasEOL: true },
      { str: 'Sem nota' },
    ),
    page({ str: 'Página dois', hasEOL: true }),
    page({ str: '   ', hasEOL: true }), // página só com espaço não deixa linha a mais
    page({ str: 'Fim' }),
  ]);
  assert.deepEqual(joined, {
    text: 'Trocas em 7 dias\nSem nota\n\nPágina dois\n\nFim',
    overLimit: false,
  });

  let consumed = 0;
  function* pages(): Generator<PdfTextItem[]> {
    for (let index = 0; index < 1000; index++) {
      consumed++;
      yield [{ str: 'x'.repeat(30_000), hasEOL: false }];
    }
  }
  const capped = joinPdfTextItems(pages());
  assert.equal(capped.overLimit, true);
  assert.equal(consumed, 4); // 30.000 x 3 + separadores ainda cabem; a quarta página passa
  const exact = joinPdfTextItems([[{ str: 'a'.repeat(100_000) }]]);
  assert.equal(exact.overLimit, false);
});

test('titleFromFileName tira .pdf e .docx e mantém a regra antiga', () => {
  assert.equal(titleFromFileName('politica_de-trocas.md'), 'politica de trocas');
  assert.equal(titleFromFileName('Cardapio-2026.pdf'), 'Cardapio 2026');
  assert.equal(titleFromFileName('Perguntas_frequentes.DOCX'), 'Perguntas frequentes');
  assert.equal(titleFromFileName('notas.txt'), 'notas');
  assert.ok(titleFromFileName(`${'a'.repeat(200)}.pdf`).length <= 120);
});

test('mensagens: exatamente as da tabela da spec, constantes e sem interpolação', () => {
  assert.deepEqual(FILE_PROBLEM_MESSAGES, {
    'too-large': 'O arquivo passa de 200 KB. Divida o texto em arquivos menores.',
    empty: 'O arquivo está vazio.',
    'not-utf8':
      'Não foi possível ler o arquivo como texto UTF-8. Salve-o como texto simples (UTF-8).',
    'content-too-large':
      'O texto do arquivo passa de 100.000 caracteres. Divida em arquivos menores.',
    'wrong-type': 'Use um arquivo .txt, .md, .pdf ou .docx.',
    'doc-legacy':
      'Arquivos .doc antigos não são aceitos. Salve como .docx ou PDF, ou cole o texto.',
    odt: 'Arquivos .odt não são aceitos. Salve como .docx ou PDF, ou cole o texto.',
    'binary-too-large': 'O arquivo passa de 10 MB. Envie um arquivo menor ou cole só o texto.',
    'not-pdf': 'Este arquivo não é um PDF válido.',
    'not-docx': 'Este arquivo não é um documento do Word (.docx) válido.',
    'docx-protected':
      'Este documento do Word está protegido por senha ou em formato antigo. Remova a senha ou salve como .docx de novo, ou cole o texto.',
    'pdf-password':
      'Este PDF está protegido por senha. Remova a senha e tente de novo, ou cole o texto.',
    'no-text':
      'Não encontramos texto neste arquivo. Se for um PDF escaneado (uma imagem), o Soprei ainda não consegue lê-lo: cole o texto no campo acima.',
    'too-many-pages':
      'O PDF tem mais de 500 páginas. Divida o arquivo ou cole só a parte que interessa.',
    unreadable:
      'Não foi possível ler este arquivo. Ele pode estar corrompido: tente salvá-lo de novo ou cole o texto.',
    timeout: 'A leitura do arquivo demorou demais. Tente um arquivo menor ou cole o texto.',
    'loader-failed':
      'Não foi possível carregar o leitor de arquivos. Recarregue a página e tente de novo.',
  });
  const source = readFileSync(new URL('./knowledge-rules.ts', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('export const FILE_PROBLEM_MESSAGES'));
  assert.doesNotMatch(block.slice(0, block.indexOf('};')), /\$\{|`/);
});

// --- Orquestração (leitores falsos, sem pdf.js nem mammoth) ---

const PDF_BYTES = ascii('%PDF-1.4\n');

function fakeFile(name: string, content: Uint8Array = PDF_BYTES): FileLike & { blob: Blob } {
  const blob = new Blob([content as BlobPart]);
  return { name, size: blob.size, slice: (start, end) => blob.slice(start, end), blob };
}

interface Pending {
  resolve: (result: ExtractResult) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
}

/** Leitor falso: cada chamada fica pendente até o teste decidir. */
function fakeExtractor(): { extractor: Extractor; calls: Pending[] } {
  const calls: Pending[] = [];
  const extractor: Extractor = (_bytes, signal) =>
    new Promise<ExtractResult>((resolve, reject) => {
      calls.push({ resolve, reject, signal });
    });
  return { extractor, calls };
}

function controllerWith(
  extractor: Extractor,
  options: { loadFails?: boolean; timeoutMs?: number } = {},
): { controller: FileReadController; fireTimeout: () => void } {
  let fire: () => void = () => undefined;
  const controller = new FileReadController({
    readBytes: readFake,
    loadPdf: () =>
      options.loadFails === true
        ? Promise.reject(new Error('Failed to fetch dynamically imported module'))
        : Promise.resolve(extractor),
    loadDocx: () => Promise.resolve(extractor),
    timeoutMs: options.timeoutMs ?? 60_000,
    setTimer: (callback) => {
      fire = callback;
      return 1;
    },
    clearTimer: () => {
      fire = () => undefined;
    },
  });
  return { controller, fireTimeout: () => fire() };
}

async function until(check: () => boolean): Promise<void> {
  for (let index = 0; index < 200 && !check(); index++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.ok(check(), 'condição não chegou');
}

test('orquestração: o segundo arquivo cancela o primeiro e o resultado tardio é descartado', async () => {
  const { extractor, calls } = fakeExtractor();
  const { controller } = controllerWith(extractor);
  let readingCalls = 0;
  const first = controller.read(fakeFile('a.pdf'), () => readingCalls++);
  await until(() => calls.length === 1);
  const second = controller.read(fakeFile('b.pdf'));
  assert.equal(calls[0]?.signal.aborted, true, 'o leitor do primeiro recebe o cancelamento');
  assert.deepEqual(await first, { status: 'cancelled' });
  // O primeiro leitor responde tarde: nada muda.
  calls[0]?.resolve({ text: 'TEXTO-DO-PRIMEIRO' });
  await until(() => calls.length === 2);
  calls[1]?.resolve({ text: '  Texto do  segundo ' });
  assert.deepEqual(await second, { status: 'text', kind: 'pdf', text: 'Texto do segundo' });
  assert.equal(readingCalls, 1);
});

test('orquestração: "Cancelar leitura" não gera erro e chama o cancelamento do leitor', async () => {
  const { extractor, calls } = fakeExtractor();
  const { controller } = controllerWith(extractor);
  const pending = controller.read(fakeFile('a.pdf'));
  await until(() => calls.length === 1);
  controller.cancel();
  assert.equal(calls[0]?.signal.aborted, true);
  const outcome: ReadOutcome = await pending;
  assert.deepEqual(outcome, { status: 'cancelled' });
});

test('orquestração: prazo estourado dá a mensagem de prazo e cancela o leitor', async () => {
  const { extractor, calls } = fakeExtractor();
  const { controller, fireTimeout } = controllerWith(extractor);
  const pending = controller.read(fakeFile('a.pdf'));
  await until(() => calls.length === 1);
  fireTimeout();
  assert.deepEqual(await pending, { status: 'problem', problem: 'timeout' });
  assert.equal(calls[0]?.signal.aborted, true);
});

test('orquestração: módulo do leitor que não carrega dá "leitor não carregou"', async () => {
  const { extractor } = fakeExtractor();
  const { controller } = controllerWith(extractor, { loadFails: true });
  assert.deepEqual(await controller.read(fakeFile('a.pdf')), {
    status: 'problem',
    problem: 'loader-failed',
  });
});

test('orquestração: erro do leitor vira a mensagem fixa (a original nunca aparece)', async () => {
  const { extractor, calls } = fakeExtractor();
  const { controller } = controllerWith(extractor);
  const pending = controller.read(fakeFile('a.pdf'));
  await until(() => calls.length === 1);
  calls[0]?.reject(new Error('SEGREDO-DO-ARQUIVO: Invalid PDF structure'));
  const outcome = await pending;
  assert.deepEqual(outcome, { status: 'problem', problem: 'unreadable' });
  assert.ok(!JSON.stringify(outcome).includes('SEGREDO'));
});

test('orquestração: problemas do leitor e do texto extraído viram as mensagens próprias', async () => {
  for (const [result, expected] of [
    [{ problem: 'pdf-password' }, { status: 'problem', problem: 'pdf-password' }],
    [{ problem: 'too-many-pages' }, { status: 'problem', problem: 'too-many-pages' }],
    [{ text: ' ​ .  ' }, { status: 'problem', problem: 'no-text' }],
    [{ text: 'a'.repeat(100_001) }, { status: 'problem', problem: 'content-too-large' }],
  ] as const) {
    const { controller } = controllerWith(() => Promise.resolve(result));
    assert.deepEqual(await controller.read(fakeFile('a.pdf')), expected);
  }
});

test('orquestração: tipo, tamanho e assinatura recusam antes de carregar o leitor', async () => {
  let loads = 0;
  const controller = new FileReadController({
    readBytes: readFake,
    loadPdf: () => {
      loads++;
      return Promise.reject(new Error('não deveria carregar'));
    },
    loadDocx: () => {
      loads++;
      return Promise.reject(new Error('não deveria carregar'));
    },
  });
  const big: FileLike = {
    name: 'grande.pdf',
    size: KNOWLEDGE_BINARY_FILE_MAX_BYTES + 1,
    slice: () => {
      throw new Error('não deveria ler');
    },
  };
  assert.deepEqual(await controller.read(big), { status: 'problem', problem: 'binary-too-large' });
  assert.deepEqual(await controller.read(fakeFile('x.pdf', ascii('não sou PDF'))), {
    status: 'problem',
    problem: 'not-pdf',
  });
  assert.deepEqual(await controller.read(fakeFile('x.doc')), {
    status: 'problem',
    problem: 'doc-legacy',
  });
  assert.deepEqual(await controller.read(fakeFile('x.txt', ascii('Política de trocas'))), {
    status: 'text',
    kind: 'text',
    text: 'Política de trocas',
  });
  assert.equal(loads, 0);
});

test('código: pdf-text só por import(), sem URLs de recursos e com as opções seguras', () => {
  const dir = new URL('./', import.meta.url);
  // Só o código (sem comentários): os comentários explicam o que não se usa.
  const pdfSource = readFileSync(new URL('./pdf-text.ts', dir), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(pdfSource, /cMapUrl|standardFontDataUrl|wasmUrl|iccUrl/);
  assert.match(pdfSource, /isEvalSupported: false/);
  assert.match(pdfSource, /enableXfa: false/);
  assert.doesNotMatch(
    pdfSource,
    /getJSActions|getFieldObjects|\.render\(|pdf_viewer|pdf\.sandbox|AnnotationLayer/,
  );
  assert.doesNotMatch(pdfSource, /console\.|localStorage|sessionStorage/);
  const sources = readdirSync(new URL('../', dir), { recursive: true, encoding: 'utf8' }).filter(
    (file) =>
      /\.(ts|tsx)$/.test(file) && !file.endsWith('.test.ts') && !file.endsWith('pdf-text.ts'),
  );
  let dynamic = 0;
  for (const file of sources) {
    const text = readFileSync(new URL(`../${file}`, dir), 'utf8');
    for (const line of text.split('\n').filter((item) => item.includes('pdf-text'))) {
      assert.match(line, /import\('\.\/pdf-text'\)/, `${file}: ${line}`);
      dynamic++;
    }
  }
  assert.equal(dynamic, 1);
  for (const file of ['knowledge-file-reader.ts', 'knowledge-file-rules.ts']) {
    assert.doesNotMatch(
      readFileSync(new URL(`./${file}`, dir), 'utf8'),
      /console\.|localStorage|sessionStorage|history\.(push|replace)State/,
    );
  }
});

// --- E2: DOCX ---

const u8 = (buffer: Buffer): Uint8Array =>
  new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

test('readZipDirectory: nomes e tamanhos de um ZIP gerado; DOCX precisa das duas partes', () => {
  const docx = buildZip(docxEntries(['Olá']));
  const directory = readZipDirectory(u8(docx));
  assert.equal(directory.ok, true);
  if (!directory.ok) return;
  assert.deepEqual(directory.names, ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']);
  const sizes = docxEntries(['Olá']).reduce(
    (total, entry) => total + Buffer.byteLength(entry.data as string, 'utf8'),
    0,
  );
  assert.equal(directory.uncompressedTotal, sizes);
  assert.equal(directory.zip64, false);
  assert.equal(docxZipProblem(u8(docx)), null);

  const withoutDocument = buildZip(
    docxEntries(['x']).filter((entry) => entry.name !== 'word/document.xml'),
  );
  assert.equal(docxZipProblem(u8(withoutDocument)), 'not-docx');
  const withoutTypes = buildZip(
    docxEntries(['x']).filter((entry) => entry.name !== '[Content_Types].xml'),
  );
  assert.equal(docxZipProblem(u8(withoutTypes)), 'not-docx');
});

test('readZipDirectory: soma acima do teto, ZIP64, truncado e sem fim de diretório recusam sem lançar', () => {
  const docx = buildZip(docxEntries(['texto']));
  assert.equal(docxZipProblem(u8(docx), 10), 'unreadable');
  assert.equal(KNOWLEDGE_DOCX_MAX_UNCOMPRESSED_BYTES, 50 * 1024 * 1024);

  // Tamanho descompactado declarado gigante (bomba de compressão): só o diretório conta.
  const bomb = Buffer.from(docx);
  const central = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bomb.writeUInt32LE(KNOWLEDGE_DOCX_MAX_UNCOMPRESSED_BYTES, central + 24);
  assert.equal(docxZipProblem(u8(bomb)), 'unreadable');

  // ZIP64: tamanho 0xFFFFFFFF na entrada ou no fim do diretório.
  const zip64 = Buffer.from(docx);
  zip64.writeUInt32LE(0xffffffff, central + 24);
  const marked = readZipDirectory(u8(zip64));
  assert.equal(marked.ok && marked.zip64, true);
  assert.equal(docxZipProblem(u8(zip64)), 'unreadable');
  const zip64End = Buffer.from(docx);
  zip64End.writeUInt16LE(0xffff, zip64End.length - 22 + 10);
  assert.equal(docxZipProblem(u8(zip64End)), 'unreadable');

  for (const broken of [
    docx.subarray(0, docx.length - 30), // truncado: sem o fim do diretório
    docx.subarray(0, 100),
    Buffer.alloc(0),
    Buffer.from('PK\x03\x04 qualquer coisa'),
  ]) {
    assert.doesNotThrow(() => readZipDirectory(u8(broken)));
    assert.equal(readZipDirectory(u8(broken)).ok, false);
    assert.equal(docxZipProblem(u8(broken)), 'unreadable');
  }
  // Diretório que aponta para fora do arquivo.
  const outside = Buffer.from(docx);
  outside.writeUInt32LE(docx.length * 2, outside.length - 22 + 16);
  assert.equal(readZipDirectory(u8(outside)).ok, false);
});

test('inflatedSizeWithin: conta os bytes reais descompactados, não o tamanho declarado (revisão I-1)', async () => {
  assert.equal(canInflateRaw(), true);
  const entriesOf = (zip: Buffer) => {
    const directory = readZipDirectory(u8(zip));
    assert.equal(directory.ok, true);
    return directory.ok ? directory.entries : [];
  };
  // DOCX normal, armazenado e compactado: cabe.
  const stored = buildZip(docxEntries(['Olá']));
  assert.equal(await inflatedSizeWithin(u8(stored), entriesOf(stored), 1024 * 1024), true);
  const deflated = buildZip(docxEntries(['Olá']).map((entry) => ({ ...entry, deflate: true })));
  assert.equal(await inflatedSizeWithin(u8(deflated), entriesOf(deflated), 1024 * 1024), true);

  // Bomba: 2 MiB de zeros compactados, declarando 1 KB. A soma declarada passa no diretório...
  const bomb = buildZip([
    ...docxEntries(['x']),
    {
      name: 'word/media/bomba.bin',
      data: Buffer.alloc(2 * 1024 * 1024),
      deflate: true,
      declaredSize: 1024,
    },
  ]);
  assert.ok(bomb.length < 64 * 1024);
  assert.equal(docxZipProblem(u8(bomb), 1024 * 1024), null);
  // ...mas a contagem real para assim que passa do teto.
  assert.equal(await inflatedSizeWithin(u8(bomb), entriesOf(bomb), 1024 * 1024), false);
  assert.equal(await inflatedSizeWithin(u8(bomb), entriesOf(bomb), 4 * 1024 * 1024), true);

  // Método desconhecido, entrada fora do arquivo e deflate corrompido recusam sem lançar.
  const [first] = entriesOf(stored);
  assert.ok(first);
  assert.equal(await inflatedSizeWithin(u8(stored), [{ ...first, method: 12 }], 1024), false);
  assert.equal(
    await inflatedSizeWithin(u8(stored), [{ ...first, localHeaderOffset: stored.length }], 1024),
    false,
  );
  assert.equal(await inflatedSizeWithin(u8(stored), [{ ...first, method: 8 }], 1024 * 1024), false);
});

test('orquestração: DOCX que não é Word recusa antes de carregar o leitor', async () => {
  let loads = 0;
  const controller = new FileReadController({
    readBytes: readFake,
    loadPdf: () => Promise.reject(new Error('x')),
    loadDocx: () => {
      loads++;
      return Promise.resolve(() => Promise.resolve({ text: 'nunca' }));
    },
  });
  const zip = buildZip([{ name: 'xl/workbook.xml', data: '<x/>' }]);
  assert.deepEqual(await controller.read(fakeFile('planilha.docx', u8(zip))), {
    status: 'problem',
    problem: 'not-docx',
  });
  assert.equal(loads, 0);
  assert.deepEqual(await controller.read(fakeFile('ok.docx', u8(buildZip(docxEntries(['a']))))), {
    status: 'text',
    kind: 'docx',
    text: 'nunca',
  });
  assert.equal(loads, 1);
});

test('código: o worker do DOCX só é criado por new Worker(new URL(...)) e usa só extractRawText', () => {
  const dir = new URL('./', import.meta.url);
  const strip = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const worker = strip(readFileSync(new URL('./docx-text.worker.ts', dir), 'utf8'));
  assert.match(worker, /import mammoth from 'mammoth';/);
  const calls = [...worker.matchAll(/mammoth\s*\.\s*(\w+)/g)].map((match) => match[1]);
  assert.deepEqual(calls, ['extractRawText']);
  assert.doesNotMatch(worker, /console\.|convertToHtml|convertToMarkdown|images|messages/);

  const reader = strip(readFileSync(new URL('./docx-text.ts', dir), 'utf8'));
  assert.match(
    reader,
    /new Worker\(new URL\('\.\/docx-text\.worker\.ts', import\.meta\.url\), \{\s*type: 'module',?\s*\}\)/,
  );
  assert.match(reader, /worker\.terminate\(\)/);
  assert.doesNotMatch(reader, /from 'mammoth'|console\./);

  const sources = readdirSync(new URL('../', dir), { recursive: true, encoding: 'utf8' }).filter(
    (file) => /\.(ts|tsx)$/.test(file) && !file.endsWith('.test.ts'),
  );
  for (const file of sources) {
    const text = readFileSync(new URL(`../${file}`, dir), 'utf8');
    if (!file.endsWith('docx-text.worker.ts')) {
      assert.doesNotMatch(text, /from 'mammoth/, file);
    }
    for (const line of text.split('\n').filter((item) => /['"]\.\/docx-text['"]/.test(item))) {
      assert.match(line, /import\('\.\/docx-text'\)/, `${file}: ${line}`);
    }
  }
});
