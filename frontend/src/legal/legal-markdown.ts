/**
 * Interpretação dos textos legais (spec 032, E1): um SUBCONJUNTO FIXO de Markdown, sem dependência e sem HTML
 * cru. Função pura: recebe texto e devolve HTML em que todo `<`, `>`, `&` e aspas vieram escapados.
 *
 * Aceito: `#`, `##` e `###`; parágrafos (linhas seguidas, unidas por espaço); listas com `- ` e numeradas
 * (`1. `; o Anexo C da spec usa passos numerados); `**negrito**`; links `[texto](url)` só com `https://`,
 * `mailto:` ou caminho que começa com `/` (nunca `//` nem `/\`); tabelas simples (cabeçalho, linha `| --- |`
 * e linhas de dados). Qualquer outra sintaxe sai como texto. Link com outro esquema (`javascript:`, `data:`)
 * sai inteiro como texto. Os marcadores `[PREENCHER: ...]` e `[CONFERIR: ...]` saem destacados (`<mark>`),
 * para o rascunho mostrar o que falta.
 */

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

const HTTPS_URL = /^https:\/\/[^\s"'<>\\`]+$/;
const MAILTO_URL = /^mailto:[^\s"'<>\\`/]+$/;
const SITE_PATH = /^\/(?![/\\])[A-Za-z0-9\-._~/#?=&%]*$/;

/** Só `https://`, `mailto:` e caminho do próprio site (`/...`, nunca `//host` nem `/\host`). */
export function isAllowedLinkUrl(url: string): boolean {
  return HTTPS_URL.test(url) || MAILTO_URL.test(url) || SITE_PATH.test(url);
}

const LINK = /^\[([^[\]\n]+)\]\(([^()\s]+)\)/;
const MARKER = /^\[(?:PREENCHER|CONFERIR): [^[\]\n]+\]/;

/**
 * Marcadores que impedem um texto de ficar `vigente`: `[PREENCHER`, `[CONFERIR`, `[DEPENDE` e `[ATUALIZAR`, sem
 * distinção de maiúsculas e com espaço tolerado depois do colchete (marcador digitado torto também barra).
 */
export const PENDING_MARKER = /\[\s*(?:PREENCHER|CONFERIR|DEPENDE|ATUALIZAR)\b/i;

function renderInline(text: string, allowBold = true): string {
  let html = '';
  let plain = '';
  const flush = () => {
    html += escapeHtml(plain);
    plain = '';
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    if (allowBold && rest.startsWith('**')) {
      const end = text.indexOf('**', i + 2);
      if (end > i + 2) {
        flush();
        html += `<strong>${renderInline(text.slice(i + 2, end), false)}</strong>`;
        i = end + 2;
        continue;
      }
    }
    if (rest.startsWith('[')) {
      const link = LINK.exec(rest);
      if (link) {
        const [whole, label, url] = link as unknown as [string, string, string];
        if (isAllowedLinkUrl(url)) {
          flush();
          const rel = url.startsWith('https://') ? ' rel="noreferrer"' : '';
          html += `<a href="${escapeHtml(url)}"${rel}>${escapeHtml(label)}</a>`;
        } else {
          plain += whole;
        }
        i += whole.length;
        continue;
      }
      const marker = MARKER.exec(rest);
      if (marker) {
        flush();
        html += `<mark class="legal-marker">${escapeHtml(marker[0])}</mark>`;
        i += marker[0].length;
        continue;
      }
    }
    plain += text[i];
    i += 1;
  }
  flush();
  return html;
}

const HEADING = /^(#{1,3}) (.+)$/;
const BULLET = /^- (.+)$/;
const NUMBERED = /^\d{1,3}\. (.+)$/;
const TABLE_ROW = /^\|.*\|$/;
const TABLE_SEPARATOR = /^\|(?:\s*:?-{3,}:?\s*\|)+$/;

function tableCells(line: string): string[] {
  return line
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
}

function renderTable(lines: readonly string[]): string | null {
  const [head, separator, ...body] = lines;
  if (head === undefined || separator === undefined || !TABLE_SEPARATOR.test(separator))
    return null;
  const columns = tableCells(head);
  if (tableCells(separator).length !== columns.length) return null;
  if (body.some((row) => tableCells(row).length !== columns.length)) return null;
  const headHtml = columns.map((cell) => `<th scope="col">${renderInline(cell)}</th>`).join('');
  const bodyHtml = body
    .map(
      (row) =>
        `<tr>${tableCells(row)
          .map((cell) => `<td>${renderInline(cell)}</td>`)
          .join('')}</tr>`,
    )
    .join('');
  return `<div class="legal-table"><table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`;
}

/** Interpreta o corpo de um texto legal (sem o cabeçalho `---`) e devolve HTML seguro. */
export function renderLegalMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  const isBlank = (line: string | undefined) => line === undefined || line.trim() === '';
  while (i < lines.length) {
    const line = (lines[i] as string).trim();
    if (line === '') {
      i += 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = (heading[1] as string).length;
      out.push(`<h${level}>${renderInline(heading[2] as string)}</h${level}>`);
      i += 1;
      continue;
    }
    if (BULLET.test(line) || NUMBERED.test(line)) {
      const pattern = BULLET.test(line) ? BULLET : NUMBERED;
      const tag = pattern === BULLET ? 'ul' : 'ol';
      const items: string[] = [];
      while (i < lines.length) {
        const match = pattern.exec((lines[i] as string).trim());
        if (!match) break;
        items.push(`<li>${renderInline(match[1] as string)}</li>`);
        i += 1;
      }
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }
    if (TABLE_ROW.test(line)) {
      const rows: string[] = [];
      while (i < lines.length && TABLE_ROW.test((lines[i] as string).trim())) {
        rows.push((lines[i] as string).trim());
        i += 1;
      }
      const table = renderTable(rows);
      out.push(table ?? rows.map((row) => `<p>${renderInline(row)}</p>`).join(''));
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && !isBlank(lines[i])) {
      const next = (lines[i] as string).trim();
      if (
        paragraph.length > 0 &&
        (HEADING.test(next) || BULLET.test(next) || NUMBERED.test(next) || TABLE_ROW.test(next))
      )
        break;
      paragraph.push(next);
      i += 1;
    }
    out.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
  }
  return out.join('\n');
}
