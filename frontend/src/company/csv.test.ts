import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { IMPORT_MAX_ROWS, parseProductsCsv, splitCsv } from './csv';

test('separador ";" com cabeçalho, preço com vírgula e linha em branco', () => {
  const parsed = parseProductsCsv(
    'sku;nome;descricao;preco;quantidade\r\ncam-001;Camiseta Azul;Algodão;59,90;12\r\n\r\nbon-2;Boné;;39,9;0\r\n',
  );
  assert.deepEqual(parsed.invalid, []);
  assert.equal(parsed.tooMany, false);
  assert.deepEqual(
    parsed.rows.map((entry) => entry.row),
    [
      {
        sku: 'CAM-001',
        name: 'Camiseta Azul',
        description: 'Algodão',
        priceCents: 5990,
        quantity: 12,
      },
      { sku: 'BON-2', name: 'Boné', description: '', priceCents: 3990, quantity: 0 },
    ],
  );
  assert.deepEqual(
    parsed.rows.map((entry) => entry.line),
    [2, 4],
  );
});

test('separador "," com aspas: vírgula decimal e ponto e vírgula dentro de campo entre aspas', () => {
  const parsed = parseProductsCsv(
    'SKU,Nome,Descricao,Preco,Quantidade\ncam-1,"Camiseta, azul","diz ""oi""; sim","1.234,50",3',
  );
  assert.deepEqual(parsed.invalid, []);
  assert.deepEqual(parsed.rows[0]?.row, {
    sku: 'CAM-1',
    name: 'Camiseta, azul',
    description: 'diz "oi"; sim',
    priceCents: 123450,
    quantity: 3,
  });
});

test('sem cabeçalho a primeira linha já é dado; linha inválida não derruba as demais', () => {
  const parsed = parseProductsCsv(
    'A-1;Produto A;;10,00;5\nB-2;;;10,00;5\nC-3;Produto C;;x;5\nD-4;Produto D;;1,00;-1\nE-5;E;;2,00;1',
  );
  assert.deepEqual(parsed.invalid, [2, 3, 4]);
  assert.deepEqual(
    parsed.rows.map((entry) => entry.row.sku),
    ['A-1', 'E-5'],
  );
});

test('mais de 200 linhas: nada é enviado', () => {
  const lines = Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => `S-${String(i)};N;;1,00;1`);
  const parsed = parseProductsCsv(lines.join('\n'));
  assert.equal(parsed.tooMany, true);
  assert.deepEqual(parsed.rows, []);
  assert.equal(parseProductsCsv(lines.slice(0, IMPORT_MAX_ROWS).join('\n')).tooMany, false);
});

test('quebra de linha dentro de aspas conta como a mesma célula e o número de linha segue o arquivo', () => {
  const rows = splitCsv('a;"x\ny";c\nd;e;f');
  assert.deepEqual(rows, [
    { line: 1, cells: ['a', 'x\ny', 'c'] },
    { line: 3, cells: ['d', 'e', 'f'] },
  ]);
});

test('a importação do front não grava a planilha em localStorage/sessionStorage/console', () => {
  for (const file of ['ImportCsv.tsx', 'csv.ts']) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /localStorage|sessionStorage|console\./);
  }
});
