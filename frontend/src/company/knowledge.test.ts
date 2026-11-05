import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ApiError } from '../api';
import { pageForPath, pathForPage } from '../account-flow';
import { allowedPages, AREA_PAGES, areaPageForPath, canOpen } from './company-nav';
import {
  documentSchema,
  KNOWLEDGE_FILE_MAX_BYTES,
  KNOWLEDGE_INVALID_MESSAGE,
  KNOWLEDGE_LIMIT_MESSAGE,
  KNOWLEDGE_TOO_LARGE_MESSAGE,
  knowledgeMessageOf,
  SAMPLE_REQUIRES_EMPTY_MESSAGE,
} from './knowledge-api';
import {
  checkFileName,
  checkFileSize,
  decodeTextFile,
  documentFormProblem,
  titleFromFileName,
} from './knowledge-rules';
import { attendanceResultSchema } from './company-api';
import { sourcesText } from './TestPage';

test('a aba Conhecimento fica depois de Persona e só abre com knowledge:manage', () => {
  const order = [...AREA_PAGES];
  assert.ok(order.indexOf('persona') < order.indexOf('conhecimento'));
  assert.ok(order.indexOf('conhecimento') < order.indexOf('equipe'));
  assert.equal(areaPageForPath('/painel/conhecimento'), 'conhecimento');
  assert.equal(pageForPath('/painel/conhecimento'), 'conhecimento');
  assert.equal(pathForPage('conhecimento'), '/painel/conhecimento');
  assert.equal(canOpen('conhecimento', ['knowledge:manage']), true);
  assert.equal(canOpen('conhecimento', ['persona:manage']), false);
  assert.ok(allowedPages(['conversation:read', 'knowledge:manage']).includes('conhecimento'));
  assert.ok(!allowedPages(['conversation:read', 'conversation:simulate']).includes('conhecimento'));
});

test('arquivo: tipo, tamanho (200 KB antes de ler), vazio, UTF-8 inválido e texto grande', () => {
  assert.equal(checkFileName('trocas.txt'), null);
  assert.equal(checkFileName('Politica.MD'), null);
  assert.equal(checkFileName('planilha.xlsx'), 'wrong-type');
  assert.equal(checkFileSize(0), 'empty');
  assert.equal(checkFileSize(KNOWLEDGE_FILE_MAX_BYTES), null);
  assert.equal(checkFileSize(KNOWLEDGE_FILE_MAX_BYTES + 1), 'too-large');

  const encode = (text: string): ArrayBuffer => {
    const bytes = new TextEncoder().encode(text);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  };
  assert.deepEqual(decodeTextFile(encode('Aceitamos devoluções.')), {
    text: 'Aceitamos devoluções.',
  });
  assert.deepEqual(decodeTextFile(encode('   \n ')), { problem: 'empty' });
  // Byte 0xE7 sozinho (ç em Latin-1) não é UTF-8 válido: vira o caractere de substituição.
  assert.deepEqual(decodeTextFile(new Uint8Array([0x61, 0xe7, 0x62]).buffer), {
    problem: 'not-utf8',
  });
  assert.deepEqual(decodeTextFile(encode('a'.repeat(100_001))), { problem: 'content-too-large' });
});

test('título sugerido pelo nome do arquivo e validação do formulário', () => {
  assert.equal(titleFromFileName('politica_de-trocas.md'), 'politica de trocas');
  assert.ok(titleFromFileName(`${'a'.repeat(200)}.txt`).length <= 120);
  assert.notEqual(documentFormProblem('  ', 'texto'), null);
  assert.notEqual(documentFormProblem('Título', '   '), null);
  assert.equal(documentFormProblem('Título', 'texto'), null);
  assert.notEqual(documentFormProblem('Título', 'a'.repeat(100_001)), null);
});

test('mensagens por code: limite, grande demais e 400; o texto do servidor nunca é lido', () => {
  const failure = (status: number, code: string | undefined) =>
    knowledgeMessageOf(new ApiError(status, 'TEXTO-DO-SERVIDOR', code));
  assert.equal(failure(409, 'KNOWLEDGE_LIMIT_REACHED'), KNOWLEDGE_LIMIT_MESSAGE);
  assert.equal(failure(400, 'KNOWLEDGE_DOCUMENT_TOO_LARGE'), KNOWLEDGE_TOO_LARGE_MESSAGE);
  assert.equal(failure(400, 'VALIDATION_ERROR'), KNOWLEDGE_INVALID_MESSAGE);
  assert.equal(failure(403, 'FORBIDDEN'), null);
  assert.equal(knowledgeMessageOf(new Error('x')), null);
  for (const message of [KNOWLEDGE_LIMIT_MESSAGE, KNOWLEDGE_TOO_LARGE_MESSAGE]) {
    assert.ok(!message.includes('TEXTO-DO-SERVIDOR'));
  }
});

test('exemplo: o 409 SAMPLE_REQUIRES_EMPTY vira a mensagem de empresa vazia', () => {
  assert.equal(
    knowledgeMessageOf(new ApiError(409, 'TEXTO-DO-SERVIDOR', 'SAMPLE_REQUIRES_EMPTY')),
    SAMPLE_REQUIRES_EMPTY_MESSAGE,
  );
});

test('contratos estritos: documento com campo desconhecido (ex.: content) é recusado', () => {
  const base = {
    id: '0190a8b0-7c1e-7000-8000-000000000001',
    title: 'Trocas',
    charCount: 10,
    chunkCount: 1,
    preview: 'p',
    isSample: false,
    createdAt: '2026-11-04T12:00:00.000Z',
  };
  assert.ok(documentSchema.safeParse(base).success);
  assert.ok(!documentSchema.safeParse({ ...base, content: 'texto inteiro' }).success);
});

test('fontes do "Testar": só rótulos; sem fontes, "Nenhuma informação da empresa usada"', () => {
  assert.equal(
    sourcesText([
      { kind: 'document', label: 'Política de trocas' },
      { kind: 'product', label: 'Camiseta Azul' },
    ]),
    'Fontes usadas: Política de trocas (documento), Camiseta Azul (produto)',
  );
  assert.equal(sourcesText([]), 'Nenhuma informação da empresa usada');
  // Servidor antigo (sem o campo) continua válido.
  const parsed = attendanceResultSchema.parse({ reply: { text: 'oi', isFallback: false } });
  assert.deepEqual(parsed.sources, []);
});

test('o front não grava documento nem texto de arquivo em localStorage/sessionStorage/console', () => {
  for (const file of [
    'KnowledgePage.tsx',
    'SampleControls.tsx',
    'knowledge-api.ts',
    'knowledge-rules.ts',
  ]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(
      source,
      /localStorage|sessionStorage|console\.|history\.(push|replace)State/,
    );
  }
});
