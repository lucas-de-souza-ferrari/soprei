/**
 * Texto de busca sem acentos e em minúsculas, feito aqui (NFD e remoção das marcas combinantes),
 * sem a extensão `unaccent` do PostgreSQL.
 */
export function normalizeSearchText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

/**
 * Texto indexado de um trecho (spec 026): a forma **com** acentos (em minúsculas) seguida da forma
 * **sem** acentos. O stemmer `portuguese` do PostgreSQL só reduz bem "devolução"/"devoluções" ao
 * mesmo radical **com** os acentos, e quem pergunta costuma digitar **sem** eles; indexar as duas
 * formas deixa as duas perguntas acharem o texto. O que vai ao modelo é sempre o original.
 */
export function buildSearchText(text: string): string {
  const accented = text.normalize('NFC').toLowerCase();
  return `${accented} ${normalizeSearchText(text)}`;
}
