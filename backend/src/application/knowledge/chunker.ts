import {
  KNOWLEDGE_CHUNK_MAX_CHARS,
  KNOWLEDGE_MAX_CHUNKS_PER_DOCUMENT,
} from '../../domain/knowledge.js';
import { ValidationError } from '../../shared/errors/index.js';

/** Código do erro para documento que passa dos limites de tamanho ou de trechos. */
export const KNOWLEDGE_DOCUMENT_TOO_LARGE = 'KNOWLEDGE_DOCUMENT_TOO_LARGE';

const NUL = String.fromCharCode(0);

/**
 * Normaliza o texto de um documento: NFC, `\r\n` e `\r` viram `\n`, espaços no fim das linhas saem.
 * Recusa NUL (o PostgreSQL não o aceita em texto) e texto vazio depois de `trim`.
 */
export function normalizeDocumentText(raw: string): string {
  if (raw.includes(NUL)) {
    throw new ValidationError('O texto não pode conter o caractere NUL');
  }
  const text = raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  if (text.length === 0) throw new ValidationError('O texto do documento está vazio');
  return text;
}

/** Corta `text` em pedaços de até `max` caracteres, no fim de frase ou no espaço mais próximo. */
function splitLong(text: string, max: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('! '),
      window.lastIndexOf('? '),
      window.lastIndexOf('.\n'),
    );
    if (cut >= max / 2) {
      cut += 1; // inclui a pontuação
    } else {
      cut = window.lastIndexOf(' ');
      if (cut < max / 2) cut = window.lastIndexOf('\n');
      if (cut < 1) cut = max; // palavra gigante: corte seco
    }
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) parts.push(rest);
  return parts.filter((part) => part.length > 0);
}

/**
 * Divide o texto em trechos (spec 026): por parágrafo (linha em branco), juntando parágrafos até
 * `KNOWLEDGE_CHUNK_MAX_CHARS`; parágrafo maior que isso é cortado no fim de frase ou no espaço
 * mais próximo; sem sobreposição. Mais de `KNOWLEDGE_MAX_CHUNKS_PER_DOCUMENT` trechos é erro.
 * Função pura: recebe o texto já normalizado.
 */
export function chunkText(
  text: string,
  maxChars: number = KNOWLEDGE_CHUNK_MAX_CHARS,
  maxChunks: number = KNOWLEDGE_MAX_CHUNKS_PER_DOCUMENT,
): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  const chunks: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current.length > 0) chunks.push(current);
    current = '';
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      flush();
      chunks.push(...splitLong(paragraph, maxChars));
      continue;
    }
    if (current.length === 0) {
      current = paragraph;
    } else if (current.length + 2 + paragraph.length <= maxChars) {
      current = `${current}\n\n${paragraph}`;
    } else {
      flush();
      current = paragraph;
    }
  }
  flush();
  if (chunks.length > maxChunks) {
    throw new ValidationError('Documento grande demais', { code: KNOWLEDGE_DOCUMENT_TOO_LARGE });
  }
  return chunks;
}
