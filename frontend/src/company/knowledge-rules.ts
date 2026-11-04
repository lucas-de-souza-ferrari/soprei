import {
  KNOWLEDGE_CONTENT_MAX,
  KNOWLEDGE_FILE_MAX_BYTES,
  KNOWLEDGE_TITLE_MAX,
} from './knowledge-api';

/** Aviso fixo da tela (spec 026): o que a empresa não deve pôr na base e para onde o texto vai. */
export const KNOWLEDGE_PRIVACY_NOTICE =
  'Não coloque dados pessoais de clientes nem segredos aqui: a IA pode citar o que está nos documentos. Os trechos usados são enviados ao provedor de IA.';

export type FileProblem = 'too-large' | 'empty' | 'not-utf8' | 'content-too-large' | 'wrong-type';

export const FILE_PROBLEM_MESSAGES: Readonly<Record<FileProblem, string>> = {
  'too-large': 'O arquivo passa de 200 KB. Divida o texto em arquivos menores.',
  empty: 'O arquivo está vazio.',
  'not-utf8':
    'Não foi possível ler o arquivo como texto UTF-8. Salve-o como texto simples (UTF-8).',
  'content-too-large':
    'O texto do arquivo passa de 100.000 caracteres. Divida em arquivos menores.',
  'wrong-type': 'Use um arquivo de texto (.txt ou .md).',
};

/** Tipo aceito: `.txt` ou `.md` (o navegador nem sempre informa o tipo MIME). */
export function checkFileName(name: string): FileProblem | null {
  return /\.(txt|md|markdown)$/i.test(name) ? null : 'wrong-type';
}

/** Tamanho em bytes, antes de ler o arquivo. */
export function checkFileSize(size: number): FileProblem | null {
  if (size === 0) return 'empty';
  return size > KNOWLEDGE_FILE_MAX_BYTES ? 'too-large' : null;
}

const BOM = new RegExp('^' + String.fromCharCode(0xfeff));
const REPLACEMENT = String.fromCharCode(0xfffd);

/**
 * Decodifica o arquivo como UTF-8. Bytes que não são UTF-8 válido viram o caractere de
 * substituição (U+FFFD) e o arquivo é recusado com uma mensagem clara (não se grava lixo).
 */
export function decodeTextFile(buffer: ArrayBuffer): { text: string } | { problem: FileProblem } {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer).replace(BOM, '');
  if (text.includes(REPLACEMENT)) return { problem: 'not-utf8' };
  if (text.trim().length === 0) return { problem: 'empty' };
  if (text.length > KNOWLEDGE_CONTENT_MAX) return { problem: 'content-too-large' };
  return { text };
}

/** Título sugerido a partir do nome do arquivo (sem a extensão), no limite do servidor. */
export function titleFromFileName(name: string): string {
  return name
    .replace(/\.(txt|md|markdown)$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .slice(0, KNOWLEDGE_TITLE_MAX);
}

/** O formulário de documento está completo? (o servidor revalida tudo). */
export function documentFormProblem(title: string, content: string): string | null {
  if (title.trim().length === 0) return 'Informe um título para o documento.';
  if (content.trim().length === 0) return 'Cole o texto do documento ou escolha um arquivo.';
  if (content.length > KNOWLEDGE_CONTENT_MAX) return FILE_PROBLEM_MESSAGES['content-too-large'];
  if (content.includes(String.fromCharCode(0))) return 'O texto tem um caractere inválido.';
  return null;
}
