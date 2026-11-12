import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  escapeHtml,
  isAllowedLinkUrl,
  PENDING_MARKER,
  renderLegalMarkdown,
} from './legal-markdown';
import {
  buildLegalPages,
  DRAFT_NOTICE,
  extractThemeScript,
  formatLegalDate,
  LEGAL_PAGES,
  LegalDocumentError,
  parseLegalDocument,
  publishedLegalPaths,
  renderLegalPage,
} from './legal-page';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');
const header = (fields: Record<string, string>) =>
  `---\n${Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')}\n---\n`;
const VALID = {
  titulo: 'Teste',
  versao: '1',
  'atualizado-em': '2026-11-12',
  situacao: 'rascunho',
};
const ASSETS = { stylesheetHref: '/assets/index-abc.css', themeScript: "/* 'soprei-theme' */" };

describe('legal-markdown: subconjunto fixo', () => {
  it('cabeçalhos, parágrafos, listas, negrito e links permitidos', () => {
    const html = renderLegalMarkdown(
      [
        '# Título',
        '## Seção',
        '### Sub',
        'Linha um',
        'linha dois com **negrito**.',
        '',
        '- item [interno](/privacidade)',
        '- item [externo](https://exemplo.com/a?b=1)',
        '',
        '1. primeiro [e-mail](mailto:privacidade@exemplo.com)',
        '2. segundo',
      ].join('\n'),
    );
    assert.equal(
      html,
      [
        '<h1>Título</h1>',
        '<h2>Seção</h2>',
        '<h3>Sub</h3>',
        '<p>Linha um linha dois com <strong>negrito</strong>.</p>',
        '<ul><li>item <a href="/privacidade">interno</a></li><li>item <a href="https://exemplo.com/a?b=1" rel="noreferrer">externo</a></li></ul>',
        '<ol><li>primeiro <a href="mailto:privacidade@exemplo.com">e-mail</a></li><li>segundo</li></ol>',
      ].join('\n'),
    );
  });

  it('tabela simples vira <table> dentro de um contêiner com rolagem própria', () => {
    const html = renderLegalMarkdown('| A | B |\n| --- | --- |\n| **x** | y |\n| z | w |');
    assert.equal(
      html,
      '<div class="legal-table"><table><thead><tr><th scope="col">A</th><th scope="col">B</th></tr></thead>' +
        '<tbody><tr><td><strong>x</strong></td><td>y</td></tr><tr><td>z</td><td>w</td></tr></tbody></table></div>',
    );
  });

  it('tabela sem separador ou com colunas desiguais sai como texto', () => {
    assert.equal(renderLegalMarkdown('| a | b |\n| c | d |'), '<p>| a | b |</p><p>| c | d |</p>');
    assert.ok(!renderLegalMarkdown('| a | b |\n| --- | --- |\n| c |').includes('<table>'));
  });

  it('marcadores [PREENCHER] e [CONFERIR] saem destacados; outros colchetes ficam como texto', () => {
    assert.equal(
      renderLegalMarkdown('Por [PREENCHER: razão social] e [CONFERIR: S1] e [nota].'),
      '<p>Por <mark class="legal-marker">[PREENCHER: razão social]</mark> e ' +
        '<mark class="legal-marker">[CONFERIR: S1]</mark> e [nota].</p>',
    );
  });

  it('sintaxe fora do subconjunto sai como texto', () => {
    assert.equal(renderLegalMarkdown('#### quatro'), '<p>#### quatro</p>');
    assert.equal(renderLegalMarkdown('* item'), '<p>* item</p>');
    assert.equal(renderLegalMarkdown('`código` e **aberto'), '<p>`código` e **aberto</p>');
    assert.equal(
      renderLegalMarkdown('![img](https://x.com/a.png)'),
      '<p>!<a href="https://x.com/a.png" rel="noreferrer">img</a></p>',
    );
  });
});

describe('legal-markdown: vetores hostis (nada de HTML cru)', () => {
  const SENTINEL = 'SENTINELA_HOSTIL';
  const vectors = [
    `<script>alert('${SENTINEL}')</script>`,
    `<img src=x onerror="alert('${SENTINEL}')">`,
    `# <svg onload=alert('${SENTINEL}')>`,
    `- <iframe src="javascript:alert('${SENTINEL}')"></iframe>`,
    `| <b>${SENTINEL}</b> | x |\n| --- | --- |\n| <script>${SENTINEL}</script> | y |`,
    `**<a href="javascript:alert('${SENTINEL}')">x</a>**`,
  ];
  for (const vector of vectors) {
    it(`escapa: ${vector.slice(0, 40)}`, () => {
      const html = renderLegalMarkdown(vector);
      assert.ok(html.includes(SENTINEL));
      assert.doesNotMatch(html, /<(script|img|svg|iframe|b)[\s>]/i);
      assert.doesNotMatch(html, /<a href="javascript/i);
      assert.match(html, /&lt;/);
    });
  }

  const badLinks = [
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox',
    'http://exemplo.com',
    '//evil.example.com',
    '/\\evil.example.com',
    'https://a.com"onmouseover=alert(1)',
    "https://a.com'x",
    'mailto:a@b.com/../x',
    'relativo/sem/barra',
  ];
  for (const url of badLinks) {
    it(`link recusado vira texto: ${url}`, () => {
      assert.equal(isAllowedLinkUrl(url), false);
      const html = renderLegalMarkdown(`[clique](${url})`);
      assert.doesNotMatch(html, /<a /);
      assert.ok(html.startsWith('<p>[clique]('));
      assert.doesNotMatch(html, /"/);
    });
  }

  it('links permitidos', () => {
    for (const url of ['https://www.soprei.com', 'mailto:a@b.com', '/termos', '/', '/a#b'])
      assert.equal(isAllowedLinkUrl(url), true, url);
  });

  it('escapeHtml cobre & < > e as duas aspas', () => {
    assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  });

  it('texto do link e do marcador também é escapado', () => {
    assert.equal(
      renderLegalMarkdown('[<b>x</b>](/termos) [PREENCHER: <i>y</i>]'),
      '<p><a href="/termos">&lt;b&gt;x&lt;/b&gt;</a> <mark class="legal-marker">[PREENCHER: &lt;i&gt;y&lt;/i&gt;]</mark></p>',
    );
  });
});

describe('legal-page: cabeçalho validado', () => {
  it('aceita o cabeçalho válido e separa o corpo', () => {
    const doc = parseLegalDocument('x.md', `${header(VALID)}\n# Título\n\nCorpo.`);
    assert.deepEqual(
      { ...doc, body: doc.body.trim() },
      {
        titulo: 'Teste',
        versao: 1,
        atualizadoEm: '2026-11-12',
        situacao: 'rascunho',
        body: '# Título\n\nCorpo.',
      },
    );
  });

  const invalid: [string, string][] = [
    ['sem cabeçalho', '# Título'],
    ['versao 0', header({ ...VALID, versao: '0' })],
    ['versao decimal', header({ ...VALID, versao: '1.5' })],
    ['versao texto', header({ ...VALID, versao: 'um' })],
    ['data inexistente', header({ ...VALID, 'atualizado-em': '2026-02-30' })],
    ['data em outro formato', header({ ...VALID, 'atualizado-em': '12/11/2026' })],
    ['situacao desconhecida', header({ ...VALID, situacao: 'publicada' })],
    ['titulo vazio', header({ ...VALID, titulo: '' })],
    ['campo desconhecido', header({ ...VALID, autor: 'x' })],
    ['campo ausente', header({ titulo: 'T', versao: '1', 'atualizado-em': '2026-11-12' })],
  ];
  for (const [name, source] of invalid) {
    it(`recusa: ${name}`, () => {
      assert.throws(() => parseLegalDocument('x.md', `${source}\nCorpo`), LegalDocumentError);
    });
  }

  it('texto vigente com [PREENCHER ou [CONFERIR é recusado; rascunho é aceito', () => {
    for (const marker of ['[PREENCHER: CNPJ]', '[CONFERIR: S1]']) {
      const body = `\nTexto ${marker}.`;
      assert.throws(
        () => parseLegalDocument('x.md', header({ ...VALID, situacao: 'vigente' }) + body),
        /vigente/,
      );
      assert.doesNotThrow(() => parseLegalDocument('x.md', header(VALID) + body));
    }
    assert.doesNotThrow(() =>
      parseLegalDocument('x.md', `${header({ ...VALID, situacao: 'vigente' })}\nTexto final.`),
    );
  });

  it('data montada do texto, sem fuso', () => {
    assert.equal(formatLegalDate('2026-11-12'), '12/11/2026');
    assert.equal(formatLegalDate('2027-01-01'), '01/01/2027');
  });
});

describe('marcadores pendentes', () => {
  it('pega os quatro tipos, sem distinção de maiúsculas e com espaço depois do colchete', () => {
    for (const text of [
      '[PREENCHER: x]',
      '[CONFERIR: S1]',
      '[DEPENDE: D8]',
      '[ATUALIZAR: E4]',
      '[preencher: x]',
      '[ Conferir: x]',
      '[\tDEPENDE: D1]',
    ])
      assert.match(text, PENDING_MARKER, text);
    for (const text of ['[nota]', 'PREENCHER sem colchete', '[PREENCHERX: x]'])
      assert.doesNotMatch(text, PENDING_MARKER, text);
    assert.throws(
      () =>
        parseLegalDocument(
          'x.md',
          `${header({ ...VALID, situacao: 'vigente' })}\nTexto [ preencher: CNPJ].`,
        ),
      LegalDocumentError,
    );
  });
});

const SOURCES = Object.fromEntries(LEGAL_PAGES.map((page) => [page.file, read(`./${page.file}`)]));
const vigente = (source: string) =>
  source
    .replace(/^situacao: rascunho$/m, 'situacao: vigente')
    .replace(/\[(PREENCHER|CONFERIR)[^\]]*\]/g, 'X');

describe('build das páginas (D2: termos só quando vigente)', () => {
  it('com os textos do repositório gera a política e a exclusão, e termos.html só se os termos forem vigentes', () => {
    const terms = parseLegalDocument('termos.md', SOURCES['termos.md'] as string);
    const pages = buildLegalPages(SOURCES, ASSETS);
    const names = pages.map((page) => page.fileName).sort();
    const expected = ['exclusao-de-dados.html', 'privacidade.html'];
    if (terms.situacao === 'vigente') expected.push('termos.html');
    assert.deepEqual(names, expected.sort());
    for (const page of pages) assert.ok(page.html.includes('Última atualização:'), page.fileName);
    if (terms.situacao === 'rascunho') {
      assert.deepEqual(publishedLegalPaths(SOURCES), ['/privacidade', '/exclusao-de-dados']);
      for (const page of pages) assert.doesNotMatch(page.html, /href="\/termos"/, page.fileName);
    }
  });

  it('termos em rascunho não geram termos.html nem link; vigentes geram os dois', () => {
    const draft = {
      ...SOURCES,
      'termos.md': (SOURCES['termos.md'] as string).replace(
        /^situacao: vigente$/m,
        'situacao: rascunho',
      ),
    };
    assert.ok(/situacao: rascunho/.test(draft['termos.md']));
    const withoutTerms = buildLegalPages(draft, ASSETS);
    assert.equal(
      withoutTerms.some((page) => page.fileName === 'termos.html'),
      false,
    );
    const published = { ...SOURCES, 'termos.md': vigente(SOURCES['termos.md'] as string) };
    const withTerms = buildLegalPages(published, ASSETS);
    assert.ok(withTerms.some((page) => page.fileName === 'termos.html'));
    const privacy = withTerms.find((page) => page.fileName === 'privacidade.html');
    assert.match(privacy?.html ?? '', /href="\/termos"/);
  });

  it('enquanto os termos são rascunho, a política e a exclusão não apontam para /termos', () => {
    if (/^situacao: vigente$/m.test(SOURCES['termos.md'] as string)) return;
    for (const file of ['privacidade.md', 'exclusao-de-dados.md'])
      assert.doesNotMatch(SOURCES[file] as string, /\]\(\/termos/, file);
  });
});

describe('textos legais do repositório', () => {
  for (const page of LEGAL_PAGES) {
    it(`${page.file}: cabeçalho válido, sem marcador em vigente e página com data, versão e faixa`, () => {
      // parseLegalDocument recusa `vigente` com [PREENCHER ou [CONFERIR: este teste falha se o dono marcar o
      // texto como vigente antes de preencher tudo.
      const doc = parseLegalDocument(page.file, read(`./${page.file}`));
      if (doc.situacao === 'vigente') assert.doesNotMatch(doc.body, /\[(PREENCHER|CONFERIR)\b/);
      assert.doesNotMatch(
        doc.body,
        /\[(DEPENDE|ATUALIZAR)\b/,
        'marcador de decisão ou etapa sem resolver',
      );
      const html = renderLegalPage(doc, page.path, ASSETS);
      assert.ok(html.includes(`Última atualização: ${formatLegalDate(doc.atualizadoEm)}`));
      assert.ok(html.includes(`Versão ${doc.versao}`));
      assert.equal(html.includes(DRAFT_NOTICE), doc.situacao === 'rascunho');
      assert.equal(html.match(/<script/g)?.length, 1, 'só o script de tema');
      assert.doesNotMatch(html, /type="module"|googleapis|gstatic|connect\.facebook|\/api\//);
      assert.match(html, /<h1>[^<]+<\/h1>/);
      assert.ok(html.includes('aria-current="page"'));
    });
  }

  it('o script de tema vem do index.html e só lê soprei-theme', () => {
    const script = extractThemeScript(read('../../index.html'));
    assert.match(script, /localStorage\.getItem\('soprei-theme'\)/);
    assert.doesNotMatch(script, /setItem|sessionStorage|fetch|cookie/);
  });

  it('nenhuma fonte vem do Google (D5)', () => {
    const css = read('../style.css');
    assert.doesNotMatch(css, /googleapis|gstatic/);
    for (const file of ['dm-sans-latin', 'dm-sans-latin-ext', 'manrope-latin', 'manrope-latin-ext'])
      assert.ok(css.includes(`url('/fonts/${file}.woff2')`), file);
    assert.doesNotMatch(read('../../index.html'), /googleapis|gstatic/);
  });
});
