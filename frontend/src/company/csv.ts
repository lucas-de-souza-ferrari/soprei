import { parseMoney } from './money';

/** Linhas por importação (o servidor também recusa mais que isto). */
export const IMPORT_MAX_ROWS = 200;

export interface ImportRow {
  readonly sku: string;
  readonly name: string;
  readonly description: string;
  readonly priceCents: number;
  readonly quantity: number;
}

export interface ParsedCsv {
  /** Linhas válidas, na ordem do arquivo, com o número da linha original (1 = primeira do arquivo). */
  readonly rows: readonly { readonly line: number; readonly row: ImportRow }[];
  /** Números das linhas do arquivo recusadas aqui (campo faltando, preço ou quantidade inválidos). */
  readonly invalid: readonly number[];
  /** Mais linhas de dados que o limite de 200: nada é enviado. */
  readonly tooMany: boolean;
}

/**
 * Separa o texto em linhas de células, com aspas (`"a;b"` e `""` para aspas literais). O separador é
 * `;` ou `,` (o que aparecer mais fora de aspas na primeira linha, com `;` ganhando o empate: a vírgula
 * costuma ser o decimal do preço). Linhas em branco são ignoradas; o número da linha é o do arquivo.
 */
export function splitCsv(text: string): { line: number; cells: string[] }[] {
  const source = text;
  const firstLine = source.split(/\r\n|\n|\r/, 1)[0] ?? '';
  let semicolons = 0;
  let commas = 0;
  let quoted = false;
  for (const char of firstLine) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === ';') semicolons += 1;
    else if (!quoted && char === ',') commas += 1;
  }
  const separator = semicolons >= commas ? ';' : ',';

  const result: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  let line = 1;
  let lineStart = 1;
  const endCell = (): void => {
    cells.push(cell);
    cell = '';
  };
  const endLine = (): void => {
    endCell();
    if (cells.some((value) => value.trim() !== '')) result.push({ line: lineStart, cells });
    cells = [];
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? '';
    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === '\n') line += 1;
        cell += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === separator) {
      endCell();
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      endLine();
      line += 1;
      lineStart = line;
    } else {
      cell += char;
    }
  }
  endLine();
  return result;
}

const HEADER_FIRST_CELLS: ReadonlySet<string> = new Set(['sku', 'codigo', 'código']);

/**
 * Planilha de produtos (spec 026, E4): colunas `sku;nome;descricao;preco;quantidade`. A primeira linha é
 * cabeçalho se a primeira célula for `sku`. Parse **no navegador**; o servidor revalida tudo.
 */
export function parseProductsCsv(text: string): ParsedCsv {
  const lines = splitCsv(text);
  const [first, ...rest] = lines;
  const data =
    first !== undefined && HEADER_FIRST_CELLS.has((first.cells[0] ?? '').trim().toLowerCase())
      ? rest
      : lines;
  if (data.length > IMPORT_MAX_ROWS) return { rows: [], invalid: [], tooMany: true };
  const rows: { line: number; row: ImportRow }[] = [];
  const invalid: number[] = [];
  for (const { line, cells } of data) {
    const [sku = '', name = '', description = '', price = '', quantity = ''] = cells.map((value) =>
      value.trim(),
    );
    const priceCents = parseMoney(price);
    if (sku === '' || name === '' || priceCents === null || !/^\d{1,7}$/.test(quantity)) {
      invalid.push(line);
      continue;
    }
    rows.push({
      line,
      row: { sku: sku.toUpperCase(), name, description, priceCents, quantity: Number(quantity) },
    });
  }
  return { rows, invalid, tooMany: false };
}
