import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

/**
 * Geradores de arquivos de teste da spec 041 (D8): PDF e ZIP/DOCX mínimos escritos à mão, sem
 * dependência e sem binário no git. O conteúdo de cada arquivo fica legível no teste.
 */

const latin1 = (text: string): Buffer => Buffer.from(text, 'latin1');

/** Escapa `(`, `)` e `\` de uma string literal do PDF. */
function pdfString(text: string): string {
  return text.replace(/[\\()]/g, (char) => `\\${char}`);
}

/** Fluxo de conteúdo que escreve as linhas em Helvetica (WinAnsi: acentos do português cabem). */
export function textContent(lines: readonly string[]): string {
  const body = lines.map((line) => `(${pdfString(line)}) Tj T*`).join('\n');
  return `BT\n/F1 12 Tf\n14 TL\n72 720 Td\n${body}\nET`;
}

/** Fluxo de conteúdo só com desenho (um retângulo preenchido): nenhuma camada de texto. */
export const DRAWING_ONLY = '0 0 1 rg\n100 500 200 120 re\nf';

// --- RC4 e o manipulador de segurança padrão (revisão 2, chave de 40 bits) ---

function rc4(key: Uint8Array, data: Uint8Array): Buffer {
  const state = Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + (state[i] as number) + (key[i % key.length] as number)) & 0xff;
    [state[i], state[j]] = [state[j] as number, state[i] as number];
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let index = 0; index < data.length; index++) {
    i = (i + 1) & 0xff;
    j = (j + (state[i] as number)) & 0xff;
    [state[i], state[j]] = [state[j] as number, state[i] as number];
    const k = state[((state[i] as number) + (state[j] as number)) & 0xff] as number;
    out[index] = (data[index] as number) ^ k;
  }
  return out;
}

const md5 = (...parts: Uint8Array[]): Buffer => {
  const hash = createHash('md5');
  for (const part of parts) hash.update(part);
  return hash.digest();
};

const PADDING = Buffer.from(
  '28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a',
  'hex',
);

function padPassword(password: string): Buffer {
  return Buffer.concat([latin1(password), PADDING]).subarray(0, 32);
}

interface Encryption {
  /** Chave do documento (5 bytes). */
  key: Buffer;
  dictionary: string;
  id: Buffer;
}

/** Algoritmos 2, 3 e 4 da especificação do PDF (revisão 2): exige senha para abrir. */
function standardEncryption(userPassword: string, ownerPassword: string): Encryption {
  const id = md5(latin1('soprei-spec-041'));
  const permissions = -44;
  const ownerKey = md5(padPassword(ownerPassword)).subarray(0, 5);
  const owner = rc4(ownerKey, padPassword(userPassword));
  const p = Buffer.alloc(4);
  p.writeInt32LE(permissions);
  const key = md5(padPassword(userPassword), owner, p, id).subarray(0, 5);
  const user = rc4(key, PADDING);
  const dictionary = `<< /Filter /Standard /V 1 /R 2 /O <${owner.toString('hex')}> /U <${user.toString('hex')}> /P ${permissions} >>`;
  return { key, dictionary, id };
}

function objectKey(key: Buffer, objectNumber: number): Buffer {
  const suffix = Buffer.from([
    objectNumber & 0xff,
    (objectNumber >> 8) & 0xff,
    (objectNumber >> 16) & 0xff,
    0,
    0,
  ]);
  return md5(key, suffix).subarray(0, Math.min(key.length + 5, 16));
}

export interface PdfOptions {
  /** Conteúdo de cada página (um fluxo por página). */
  pages: readonly string[];
  /** Senha de abertura (o PDF sai cifrado com RC4 de 40 bits). */
  userPassword?: string;
}

/** PDF mínimo com tabela `xref` calculada; cada página tem um fluxo de conteúdo. */
export function buildPdf(options: PdfOptions): Buffer {
  const pageCount = options.pages.length;
  // 1 catálogo, 2 páginas, 3 fonte, depois pares (página, conteúdo).
  const pageNumber = (index: number): number => 4 + index * 2;
  const contentNumber = (index: number): number => 5 + index * 2;
  const encryption =
    options.userPassword === undefined
      ? null
      : standardEncryption(options.userPassword, 'dono-do-arquivo');
  const objects: Buffer[] = [];
  objects[1] = latin1('<< /Type /Catalog /Pages 2 0 R >>');
  const kids = options.pages.map((_, index) => `${pageNumber(index)} 0 R`).join(' ');
  objects[2] = latin1(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`);
  objects[3] = latin1(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  );
  options.pages.forEach((content, index) => {
    objects[pageNumber(index)] = latin1(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNumber(index)} 0 R >>`,
    );
    let stream = latin1(content);
    if (encryption !== null) stream = rc4(objectKey(encryption.key, contentNumber(index)), stream);
    objects[contentNumber(index)] = Buffer.concat([
      latin1(`<< /Length ${stream.length} >>\nstream\n`),
      stream,
      latin1('\nendstream'),
    ]);
  });
  let encryptNumber = 0;
  if (encryption !== null) {
    encryptNumber = objects.length;
    objects[encryptNumber] = latin1(encryption.dictionary);
  }

  const chunks: Buffer[] = [latin1('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')];
  let offset = chunks[0]?.length ?? 0;
  const offsets: number[] = [];
  for (let number = 1; number < objects.length; number++) {
    const body = objects[number] as Buffer;
    const chunk = Buffer.concat([latin1(`${number} 0 obj\n`), body, latin1('\nendobj\n')]);
    offsets[number] = offset;
    chunks.push(chunk);
    offset += chunk.length;
  }
  const size = objects.length;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let number = 1; number < size; number++) {
    xref += `${String(offsets[number]).padStart(10, '0')} 00000 n \n`;
  }
  const extra =
    encryption === null
      ? ''
      : ` /Encrypt ${encryptNumber} 0 R /ID [<${encryption.id.toString('hex')}> <${encryption.id.toString('hex')}>]`;
  const trailer = `trailer\n<< /Size ${size} /Root 1 0 R${extra} >>\nstartxref\n${offset}\n%%EOF\n`;
  chunks.push(latin1(xref + trailer));
  return Buffer.concat(chunks);
}

// --- ZIP "stored" (sem compressão) e DOCX mínimo ---

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: string | Buffer;
  /** Compacta com deflate (método 8); sem isso a entrada é "armazenada". */
  deflate?: boolean;
  /** Tamanho descompactado declarado (para simular a bomba que mente o tamanho). */
  declaredSize?: number;
}

/** ZIP com CRC-32 e diretório central; entradas armazenadas ou compactadas com deflate. */
export function buildZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data;
    const crc = crc32(raw);
    const method = entry.deflate === true ? 8 : 0;
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const declared = entry.declaredSize ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // nomes em UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

function escapeXml(text: string): string {
  return text.replace(/[<>&"]/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** Entradas de um DOCX mínimo: um `w:p` por parágrafo (lista vazia = documento sem texto). */
export function docxEntries(paragraphs: readonly string[]): ZipEntry[] {
  const body = paragraphs
    .map((text) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`)
    .join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  return [
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/document.xml', data: document },
  ];
}

export function buildDocx(paragraphs: readonly string[]): Buffer {
  return buildZip(docxEntries(paragraphs));
}

/** Cabeçalho do contêiner OLE (`.doc` antigo ou DOCX protegido por senha) seguido de zeros. */
export function oleFile(): Buffer {
  return Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(512)]);
}
