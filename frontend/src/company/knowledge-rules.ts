import {
  KNOWLEDGE_CONTENT_MAX,
  KNOWLEDGE_FILE_MAX_BYTES,
  KNOWLEDGE_TITLE_MAX,
} from './knowledge-api';

/** Aviso fixo da tela (spec 026): o que a empresa não deve pôr na base e para onde o texto vai. */
export const KNOWLEDGE_PRIVACY_NOTICE =
  'Não coloque dados pessoais das pessoas que escrevem para a empresa nem segredos aqui: a IA pode citar o que está nos documentos. Os trechos usados são enviados ao provedor de IA.';

export type FileProblem =
  | 'too-large'
  | 'empty'
  | 'not-utf8'
  | 'content-too-large'
  | 'wrong-type'
  // Spec 040: PDF e DOCX lidos no navegador.
  | 'doc-legacy'
  | 'odt'
  | 'binary-too-large'
  | 'not-pdf'
  | 'not-docx'
  | 'docx-protected'
  | 'pdf-password'
  | 'no-text'
  | 'too-many-pages'
  | 'unreadable'
  | 'timeout'
  | 'loader-failed';

/**
 * Mensagens fixas (spec 026 e 040). Nunca interpolam texto do arquivo nem a mensagem de erro do
 * pdf.js, do mammoth ou do navegador.
 */
export const FILE_PROBLEM_MESSAGES: Readonly<Record<FileProblem, string>> = {
  'too-large': 'O arquivo passa de 200 KB. Divida o texto em arquivos menores.',
  empty: 'O arquivo está vazio.',
  'not-utf8':
    'Não foi possível ler o arquivo como texto UTF-8. Salve-o como texto simples (UTF-8).',
  'content-too-large':
    'O texto do arquivo passa de 100.000 caracteres. Divida em arquivos menores.',
  'wrong-type': 'Use um arquivo .txt, .md, .pdf ou .docx.',
  'doc-legacy': 'Arquivos .doc antigos não são aceitos. Salve como .docx ou PDF, ou cole o texto.',
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
};

/** Tipo aceito: `.txt`, `.md`, `.pdf` ou `.docx` (o navegador nem sempre informa o tipo MIME). */
export function checkFileName(name: string): FileProblem | null {
  return /\.(txt|md|markdown|pdf|docx)$/i.test(name) ? null : 'wrong-type';
}

/** Tamanho em bytes de um arquivo de texto, antes de ler o arquivo. */
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
    .replace(/\.(txt|md|markdown|pdf|docx)$/i, '')
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
