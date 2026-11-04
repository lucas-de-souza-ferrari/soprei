import { KNOWLEDGE_QUERY_MAX_CHARS, KNOWLEDGE_QUERY_MAX_TERMS } from '../../domain/knowledge.js';
import { normalizeSearchText } from './normalize.js';

const TERM_MIN = 2;
const TERM_MAX = 30;

/**
 * Palavras muito comuns e cumprimentos: não entram na consulta nem contam como "palavra útil" (a
 * configuração `portuguese` do PostgreSQL descarta as vazias; isto evita consultar só por "oi").
 */
const COMMON_WORDS: ReadonlySet<string> = new Set([
  'que',
  'por',
  'para',
  'com',
  'uma',
  'uns',
  'umas',
  'dos',
  'das',
  'nos',
  'nas',
  'mas',
  'sim',
  'nao',
  'voce',
  'voces',
  'qual',
  'quais',
  'como',
  'onde',
  'quando',
  'tem',
  'tenho',
  'ola',
  'oi',
  'bom',
  'dia',
  'boa',
  'tarde',
  'noite',
  'obrigado',
  'obrigada',
  'favor',
  'queria',
  'gostaria',
  'quero',
  'saber',
  'sobre',
  'ai',
  'ja',
  'la',
  'ca',
  'ou',
  'em',
  'ao',
  'um',
  'no',
  'na',
  'de',
  'da',
  'do',
  'se',
  'eu',
  'me',
  'te',
  'pq',
  'vc',
  'vcs',
  'tudo',
  'bem',
  'ok',
  'blz',
]);

/** Menos que isto de palavras úteis no lote: a consulta ganha o último turno do contato (decisão 4). */
export const KNOWLEDGE_MIN_USEFUL_TERMS = 4;

/**
 * Palavras do texto (letras e dígitos), em minúsculas e com os acentos que o contato digitou. A
 * chave é a forma sem acento (só `[a-z0-9]`, 2 a 30 caracteres); o valor é a forma digitada.
 */
function extractWords(
  text: string,
  max: number,
  skipCommon: boolean,
): { plain: string; typed: string }[] {
  const lowered = text.slice(0, KNOWLEDGE_QUERY_MAX_CHARS).normalize('NFC').toLowerCase();
  const seen = new Map<string, string>();
  for (const match of lowered.matchAll(/[\p{L}\p{N}]+/gu)) {
    const typed = match[0];
    const plain = normalizeSearchText(typed);
    if (!/^[a-z0-9]+$/.test(plain)) continue; // alfabeto fora do latino: ignora
    if (plain.length < TERM_MIN || plain.length > TERM_MAX) continue;
    if (skipCommon && COMMON_WORDS.has(plain)) continue;
    if (!seen.has(plain)) seen.set(plain, typed);
    if (seen.size >= max) break;
  }
  return [...seen].map(([plain, typed]) => ({ plain, typed }));
}

/** Termos `[a-z0-9]` de 2 a 30 caracteres, sem acento, sem repetição, até `max`. */
export function extractTerms(
  text: string,
  max: number = KNOWLEDGE_QUERY_MAX_TERMS,
  skipCommon = false,
): string[] {
  return extractWords(text, max, skipCommon).map((word) => word.plain);
}

/** Quantas palavras do texto têm cara de conteúdo (não são cumprimento nem palavra vazia comum). */
export function usefulTermCount(text: string): number {
  return extractTerms(text, KNOWLEDGE_QUERY_MAX_TERMS, true).filter((term) => term.length >= 3)
    .length;
}

/**
 * Quem digita sem acento ("devolucao") não casa com o radical que o stemmer tira de "devolução".
 * Para as terminações mais comuns, acrescenta a forma acentuada e a singular/plural que o contato
 * provavelmente quis dizer. Só letras: nenhuma variante tem operador de `tsquery`.
 */
function accentVariants(plain: string): string[] {
  const variants: string[] = [];
  if (plain.endsWith('coes')) {
    const stem = plain.slice(0, -4);
    variants.push(`${stem}ções`, `${stem}ção`, `${stem}cao`);
  } else if (plain.endsWith('cao')) {
    variants.push(`${plain.slice(0, -3)}ção`);
  } else if (plain.endsWith('oes')) {
    const stem = plain.slice(0, -3);
    variants.push(`${stem}ões`, `${stem}ão`, `${stem}ao`);
  } else if (plain.endsWith('ao')) {
    variants.push(`${plain.slice(0, -2)}ão`);
  }
  return variants;
}

/**
 * `tsquery` de OU (`a | b | c`) para `to_tsquery('portuguese', $1)`. Só entram letras e dígitos
 * (sem operador, aspas nem parêntese), então a consulta não pode alterar a estrutura da `tsquery`.
 * Cada palavra entra sem acento e, se foi digitada com acento, também como digitada (o texto é
 * indexado nas duas formas). Sem termo útil devolve `null` (nada é consultado).
 */
export function buildQuery(text: string): string | null {
  const words = extractWords(text, KNOWLEDGE_QUERY_MAX_TERMS, true);
  if (words.length === 0) return null;
  const lexemes = new Set<string>();
  for (const { plain, typed } of words) {
    lexemes.add(plain);
    if (typed !== plain) lexemes.add(typed);
    else for (const variant of accentVariants(plain)) lexemes.add(variant);
  }
  return [...lexemes].join(' | ');
}

/**
 * Consulta do turno (decisão 4): o texto do lote; se ele tem poucas palavras úteis ("e quanto
 * custa?"), junta o último turno do contato do histórico. O texto nunca é logado.
 */
export function buildKnowledgeQuery(
  batchText: string,
  lastUserTurn: string | undefined,
): string | null {
  const batch = batchText.slice(0, KNOWLEDGE_QUERY_MAX_CHARS);
  const needsContext = usefulTermCount(batch) < KNOWLEDGE_MIN_USEFUL_TERMS;
  if (needsContext && lastUserTurn !== undefined) {
    return buildQuery(`${batch} ${lastUserTurn.slice(0, KNOWLEDGE_QUERY_MAX_CHARS)}`);
  }
  return buildQuery(batch);
}
