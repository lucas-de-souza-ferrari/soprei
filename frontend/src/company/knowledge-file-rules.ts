import { KNOWLEDGE_CONTENT_MAX, KNOWLEDGE_FILE_MAX_BYTES } from './knowledge-api';
import type { FileProblem } from './knowledge-rules';

/**
 * Regras puras da leitura de arquivos da base de conhecimento (spec 040): tipo pelo nome, tamanho
 * antes de ler, assinatura pelos primeiros bytes, diretório do ZIP do DOCX e normalização do texto
 * extraído. Nada aqui toca o pdf.js, o mammoth nem o DOM; tudo roda em Node nos testes.
 */

/** PDF e DOCX (D2): o servidor recebe no máximo 100.000 caracteres; o custo é só memória do navegador. */
export const KNOWLEDGE_BINARY_FILE_MAX_BYTES = 10 * 1024 * 1024;
/** D7: teto de páginas do PDF (só pega catálogos de imagem; texto chega a 100.000 caracteres antes). */
export const KNOWLEDGE_PDF_MAX_PAGES = 500;
/** D7: soma do tamanho descompactado declarado no diretório do ZIP (defesa contra bomba de compressão). */
export const KNOWLEDGE_DOCX_MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
/** D7: prazo de toda leitura de PDF ou DOCX. */
export const KNOWLEDGE_FILE_READ_TIMEOUT_MS = 60_000;
/** Bytes lidos antes do resto para conferir a assinatura. */
export const FILE_HEAD_BYTES = 1024;

export type FileKind = 'text' | 'pdf' | 'docx';

/** Tipo pela extensão (minúsculas ou maiúsculas). `.doc` e `.odt` têm mensagens próprias. */
export function detectFileKind(name: string): { kind: FileKind } | { problem: FileProblem } {
  const match = /\.([a-z0-9]+)$/i.exec(name);
  const extension = match?.[1]?.toLowerCase() ?? '';
  if (extension === 'txt' || extension === 'md' || extension === 'markdown')
    return { kind: 'text' };
  if (extension === 'pdf') return { kind: 'pdf' };
  if (extension === 'docx') return { kind: 'docx' };
  if (extension === 'doc') return { problem: 'doc-legacy' };
  if (extension === 'odt') return { problem: 'odt' };
  return { problem: 'wrong-type' };
}

/** Tamanho em bytes, antes de ler: texto até 200 KB, PDF e DOCX até 10 MB, nunca vazio. */
export function checkFileSizeFor(kind: FileKind, size: number): FileProblem | null {
  if (size === 0) return 'empty';
  if (kind === 'text') return size > KNOWLEDGE_FILE_MAX_BYTES ? 'too-large' : null;
  return size > KNOWLEDGE_BINARY_FILE_MAX_BYTES ? 'binary-too-large' : null;
}

const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const ZIP_HEADER = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04
const OLE_HEADER = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function startsWith(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
  if (at + prefix.length > bytes.length) return false;
  return prefix.every((value, index) => bytes[at + index] === value);
}

/**
 * Assinatura pelo conteúdo (só os primeiros 1.024 bytes). O PDF tolera lixo antes do cabeçalho;
 * o DOCX é um ZIP. O contêiner OLE é `.doc` antigo ou DOCX protegido por senha.
 */
export function checkMagicBytes(kind: FileKind, head: Uint8Array): FileProblem | null {
  if (kind === 'text') return null;
  if (kind === 'pdf') {
    const limit = Math.min(head.length, FILE_HEAD_BYTES);
    for (let index = 0; index + PDF_HEADER.length <= limit; index++) {
      if (startsWith(head, PDF_HEADER, index)) return null;
    }
    return 'not-pdf';
  }
  if (startsWith(head, ZIP_HEADER)) return null;
  if (startsWith(head, OLE_HEADER)) return 'docx-protected';
  return 'not-docx';
}

export interface ZipEntry {
  readonly method: number;
  readonly compressedSize: number;
  readonly localHeaderOffset: number;
}

export type ZipDirectory =
  | {
      readonly ok: true;
      readonly names: readonly string[];
      /** Soma do tamanho descompactado declarado das entradas. */
      readonly uncompressedTotal: number;
      readonly zip64: boolean;
      /** Método, tamanho compactado e posição do cabeçalho local de cada entrada (na ordem). */
      readonly entries: readonly ZipEntry[];
    }
  | { readonly ok: false };

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_SIZE = 22;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const CENTRAL_SIZE = 46;

/**
 * Lê o diretório central de um ZIP (nomes e tamanho descompactado declarado), sem descompactar nada
 * e sem dependência. ZIP truncado, sem fim de diretório ou com entradas fora dos limites devolve
 * `{ ok: false }` (nunca lança). ZIP64 é marcado e recusado por quem chama.
 */
export function readZipDirectory(bytes: Uint8Array): ZipDirectory {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < EOCD_SIZE) return { ok: false };
    // O fim do diretório fica nos últimos 22 bytes mais o comentário (até 65.535 bytes).
    const lowest = Math.max(0, bytes.length - EOCD_SIZE - 0xffff);
    let eocd = -1;
    for (let index = bytes.length - EOCD_SIZE; index >= lowest; index--) {
      if (view.getUint32(index, true) === EOCD_SIGNATURE) {
        eocd = index;
        break;
      }
    }
    if (eocd < 0) return { ok: false };
    const entries = view.getUint16(eocd + 10, true);
    const directorySize = view.getUint32(eocd + 12, true);
    const directoryOffset = view.getUint32(eocd + 16, true);
    const hasLocator = eocd >= 20 && view.getUint32(eocd - 20, true) === ZIP64_LOCATOR_SIGNATURE;
    if (
      hasLocator ||
      entries === 0xffff ||
      directorySize === 0xffffffff ||
      directoryOffset === 0xffffffff
    ) {
      return { ok: true, names: [], uncompressedTotal: 0, zip64: true, entries: [] };
    }
    if (directoryOffset + directorySize > eocd) return { ok: false };
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const names: string[] = [];
    const zipEntries: ZipEntry[] = [];
    let uncompressedTotal = 0;
    let zip64 = false;
    let cursor = directoryOffset;
    for (let entry = 0; entry < entries; entry++) {
      if (cursor + CENTRAL_SIZE > eocd) return { ok: false };
      if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) return { ok: false };
      const method = view.getUint16(cursor + 10, true);
      const compressed = view.getUint32(cursor + 20, true);
      const uncompressed = view.getUint32(cursor + 24, true);
      const nameLength = view.getUint16(cursor + 28, true);
      const extraLength = view.getUint16(cursor + 30, true);
      const commentLength = view.getUint16(cursor + 32, true);
      const localHeaderOffset = view.getUint32(cursor + 42, true);
      const next = cursor + CENTRAL_SIZE + nameLength + extraLength + commentLength;
      if (next > eocd) return { ok: false };
      if (compressed === 0xffffffff || uncompressed === 0xffffffff) zip64 = true;
      names.push(
        decoder.decode(bytes.subarray(cursor + CENTRAL_SIZE, cursor + CENTRAL_SIZE + nameLength)),
      );
      uncompressedTotal += uncompressed;
      zipEntries.push({ method, compressedSize: compressed, localHeaderOffset });
      cursor = next;
    }
    return { ok: true, names, uncompressedTotal, zip64, entries: zipEntries };
  } catch {
    return { ok: false };
  }
}

/**
 * Confere o ZIP do DOCX depois de lê-lo inteiro: precisa ter `word/document.xml` e
 * `[Content_Types].xml` (senão é `.xlsx`, `.pptx`, `.odt` ou ZIP qualquer renomeado); ZIP64 e soma
 * descompactada acima do teto são recusados como "não foi possível ler".
 */
export function docxZipProblem(
  bytes: Uint8Array,
  maxUncompressed = KNOWLEDGE_DOCX_MAX_UNCOMPRESSED_BYTES,
): FileProblem | null {
  const directory = readZipDirectory(bytes);
  if (!directory.ok) return 'unreadable';
  if (directory.zip64 || directory.uncompressedTotal > maxUncompressed) return 'unreadable';
  const names = new Set(directory.names);
  if (!names.has('word/document.xml') || !names.has('[Content_Types].xml')) return 'not-docx';
  return null;
}

// Controles C0 (exceto a quebra de linha; a tabulação vira espaço antes) e C1, mais DEL.
// eslint-disable-next-line no-control-regex -- remover caracteres de controle é o objetivo da regra.
const CONTROLS = new RegExp('[\\u0000-\\u0009\\u000B-\\u001F\\u007F-\\u009F]', 'g');
// U+FFFD, hífen suave e caracteres de largura zero (inclui o BOM).
const INVISIBLES = new RegExp('[\\uFFFD\\u00AD\\u200B-\\u200D\\u2060\\uFEFF]', 'g');

/**
 * Normaliza o texto extraído de PDF ou DOCX. Idempotente; o resultado nunca tem NUL. O servidor
 * normaliza de novo (NFC, quebras de linha, espaços no fim da linha).
 */
export function normalizeExtractedText(input: string): string {
  const cleaned = input
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(CONTROLS, '')
    .replace(INVISIBLES, '')
    // Depois de remover os invisíveis, para a remoção não deixar uma sequência fora da forma NFC.
    .normalize('NFC')
    .replace(/[^\S\n]+/g, ' ');
  return cleaned
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Problema do texto já normalizado: sem letra nem dígito (D4) ou acima de 100.000 caracteres (D3). */
export function extractedTextProblem(
  text: string,
  limit = KNOWLEDGE_CONTENT_MAX,
): FileProblem | null {
  if (!/[\p{L}\p{N}]/u.test(text)) return 'no-text';
  if (text.length > limit) return 'content-too-large';
  return null;
}

/** Item de `getTextContent` do pdf.js (só os campos usados). */
export interface PdfTextItem {
  readonly str: string;
  readonly hasEOL?: boolean;
}

/** Texto de uma página: concatena `str`; `hasEOL` vira quebra de linha. */
export function pdfPageText(items: Iterable<PdfTextItem>): string {
  let text = '';
  for (const item of items) {
    text += item.str;
    if (item.hasEOL === true) text += '\n';
  }
  return text;
}

/**
 * Junta as páginas do PDF uma a uma (cada página normalizada, separadas por linha em branco) e avisa
 * assim que o texto passa do limite: quem lê o PDF para ali, sem ler o resto (D3).
 */
export class PdfTextCollector {
  readonly #parts: string[] = [];
  #length = 0;

  constructor(private readonly limit = KNOWLEDGE_CONTENT_MAX) {}

  /** Acrescenta uma página; devolve `false` quando o texto já passou do limite. */
  add(items: Iterable<PdfTextItem>): boolean {
    const page = normalizeExtractedText(pdfPageText(items));
    if (page.length > 0) {
      this.#length += (this.#parts.length > 0 ? 2 : 0) + page.length;
      this.#parts.push(page);
    }
    return this.#length <= this.limit;
  }

  get overLimit(): boolean {
    return this.#length > this.limit;
  }

  text(): string {
    return this.#parts.join('\n\n');
  }
}

/** Junta páginas já lidas, parando de consumir assim que o texto passa do limite. */
export function joinPdfTextItems(
  pages: Iterable<Iterable<PdfTextItem>>,
  limit = KNOWLEDGE_CONTENT_MAX,
): { text: string; overLimit: boolean } {
  const collector = new PdfTextCollector(limit);
  for (const page of pages) {
    if (!collector.add(page)) break;
  }
  return { text: collector.text(), overLimit: collector.overLimit };
}
