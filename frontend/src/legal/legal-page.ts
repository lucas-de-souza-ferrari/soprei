/**
 * Páginas públicas dos textos legais (spec 032, E1): lê o cabeçalho `---` de cada arquivo, valida e monta o
 * HTML estático que o plugin do `vite.config.ts` grava no build (e serve no desenvolvimento). Funções puras:
 * o plugin entrega o texto, o endereço do CSS do site e o script de tema do `index.html`.
 *
 * A página não chama a API, não grava nada no navegador e não carrega nenhum script além do de tema.
 */
import { escapeHtml, PENDING_MARKER, renderLegalMarkdown } from './legal-markdown';

export type LegalStatus = 'rascunho' | 'vigente';

export interface LegalDocument {
  readonly titulo: string;
  readonly versao: number;
  /** `AAAA-MM-DD`, sem fuso. */
  readonly atualizadoEm: string;
  readonly situacao: LegalStatus;
  /** Corpo em Markdown (sem o cabeçalho). */
  readonly body: string;
}

/** Os três textos: endereço público (sem `.html`) e arquivo em `src/legal/`. */
export const LEGAL_PAGES = [
  { path: '/privacidade', file: 'privacidade.md', label: 'Política de Privacidade' },
  { path: '/termos', file: 'termos.md', label: 'Termos de Uso' },
  { path: '/exclusao-de-dados', file: 'exclusao-de-dados.md', label: 'Exclusão de dados' },
] as const;

export class LegalDocumentError extends Error {
  constructor(file: string, reason: string) {
    super(`texto legal inválido (${file}): ${reason}`);
    this.name = 'LegalDocumentError';
  }
}

const KEYS = ['titulo', 'versao', 'atualizado-em', 'situacao'] as const;

function isRealDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * Lê e valida o arquivo: cabeçalho com exatamente `titulo`, `versao` (inteiro >= 1), `atualizado-em` (data real)
 * e `situacao` (`rascunho` ou `vigente`). Texto `vigente` com `[PREENCHER` ou `[CONFERIR` é recusado. Qualquer
 * problema lança `LegalDocumentError`, o que quebra o build.
 */
export function parseLegalDocument(file: string, source: string): LegalDocument {
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const header = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!header) throw new LegalDocumentError(file, 'cabeçalho --- ausente');
  const fields = new Map<string, string>();
  for (const line of (header[1] as string).split('\n')) {
    const match = /^([a-z-]+):\s*(.*?)\s*$/.exec(line);
    if (!match) throw new LegalDocumentError(file, 'linha do cabeçalho fora do formato');
    const key = match[1] as string;
    if (!(KEYS as readonly string[]).includes(key))
      throw new LegalDocumentError(file, `campo desconhecido: ${key}`);
    if (fields.has(key)) throw new LegalDocumentError(file, `campo repetido: ${key}`);
    fields.set(key, match[2] as string);
  }
  for (const key of KEYS)
    if (!fields.has(key)) throw new LegalDocumentError(file, `campo ausente: ${key}`);
  const titulo = fields.get('titulo') as string;
  const versao = fields.get('versao') as string;
  const atualizadoEm = fields.get('atualizado-em') as string;
  const situacao = fields.get('situacao') as string;
  if (titulo === '' || titulo.length > 120) throw new LegalDocumentError(file, 'titulo inválido');
  if (!/^[1-9]\d{0,3}$/.test(versao))
    throw new LegalDocumentError(file, 'versao deve ser inteiro >= 1');
  if (!isRealDate(atualizadoEm))
    throw new LegalDocumentError(file, 'atualizado-em deve ser uma data AAAA-MM-DD real');
  if (situacao !== 'rascunho' && situacao !== 'vigente')
    throw new LegalDocumentError(file, 'situacao deve ser rascunho ou vigente');
  const body = text.slice(header[0].length);
  if (situacao === 'vigente' && PENDING_MARKER.test(body))
    throw new LegalDocumentError(file, 'texto vigente ainda tem [PREENCHER ou [CONFERIR');
  return { titulo, versao: Number(versao), atualizadoEm, situacao, body };
}

/** `2026-11-12` -> `12/11/2026`, montado do texto (sem conversão de fuso). */
export function formatLegalDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  return `${day}/${month}/${year}`;
}

export const DRAFT_NOTICE = 'Texto preliminar, em revisão. Pode mudar.';

export interface LegalPageAssets {
  /** Endereço do CSS do site (no build, o arquivo com hash; no desenvolvimento, `/src/style.css`). */
  readonly stylesheetHref: string;
  /** Conteúdo do script de tema do `index.html` (lê só `soprei-theme`). */
  readonly themeScript: string;
}

/** Monta a página inteira. O primeiro `# ` do texto vira o `h1`, seguido da data e da versão. */
export function renderLegalPage(
  doc: LegalDocument,
  currentPath: string,
  assets: LegalPageAssets,
): string {
  const lines = doc.body.replace(/^\n+/, '').split('\n');
  const first = lines[0] ?? '';
  const hasTitle = /^# .+$/.test(first.trim());
  const heading = hasTitle ? first.trim().slice(2) : doc.titulo;
  const body = renderLegalMarkdown(hasTitle ? lines.slice(1).join('\n') : lines.join('\n'));
  const nav = LEGAL_PAGES.map((page) =>
    page.path === currentPath
      ? `<li><a href="${page.path}" aria-current="page">${escapeHtml(page.label)}</a></li>`
      : `<li><a href="${page.path}">${escapeHtml(page.label)}</a></li>`,
  ).join('');
  const draft =
    doc.situacao === 'rascunho' ? `<p class="legal-draft" role="note">${DRAFT_NOTICE}</p>` : '';
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light dark" />
    <meta name="description" content="${escapeHtml(`${doc.titulo} do Soprei.`)}" />
    <link rel="icon" type="image/svg+xml" href="/logo-icon.svg" />
    <script>${assets.themeScript}</script>
    <link rel="stylesheet" href="${escapeHtml(assets.stylesheetHref)}" />
    <title>${escapeHtml(doc.titulo)} — Soprei</title>
  </head>
  <body class="legal-body">
    <a class="skip" href="#conteudo">Pular para o conteúdo</a>
    <header class="legal-header">
      <a href="/" class="legal-brand">
        <img src="/soprei-logo.svg" alt="Soprei — início" class="legal-logo-light" />
        <img src="/soprei-logo-dark.svg" alt="Soprei — início" class="legal-logo-dark" />
      </a>
    </header>
    <main id="conteudo" class="legal-main">
      ${draft}
      <article class="legal-doc">
        <h1>${escapeHtml(heading)}</h1>
        <p class="legal-meta"><span>Última atualização: ${formatLegalDate(doc.atualizadoEm)}</span> <span>Versão ${doc.versao}</span></p>
${body}
      </article>
      <nav class="legal-nav" aria-label="Documentos legais"><ul>${nav}</ul></nav>
    </main>
  </body>
</html>
`;
}

/** O script de tema do `index.html` (o primeiro `<script>` sem atributos). Ausente ou repetido quebra o build. */
export function extractThemeScript(indexHtml: string): string {
  const scripts = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (scripts.length !== 1) throw new Error('index.html precisa de exatamente um <script> de tema');
  const script = (scripts[0] as RegExpMatchArray)[1] as string;
  if (!script.includes("'soprei-theme'") || script.includes('</'))
    throw new Error('script de tema do index.html inesperado');
  return script;
}
