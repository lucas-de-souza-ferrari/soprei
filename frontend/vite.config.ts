import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { loadEnv } from 'vite';
import {
  buildLegalPages,
  extractThemeScript,
  LEGAL_PAGES,
  parseLegalDocument,
  publishedLegalPaths,
  renderLegalPage,
} from './src/legal/legal-page';

const legalDir = fileURLToPath(new URL('./src/legal/', import.meta.url));
const indexHtmlPath = fileURLToPath(new URL('./index.html', import.meta.url));

/** Os três textos, por nome de arquivo (relidos a cada uso: no desenvolvimento, editar o texto já vale). */
function readLegalSources(): Record<string, string> {
  return Object.fromEntries(
    LEGAL_PAGES.map((page) => [page.file, readFileSync(legalDir + page.file, 'utf8')]),
  );
}

/**
 * Páginas legais estáticas (spec 032, E1): no build grava `privacidade.html` e `exclusao-de-dados.html` (e
 * `termos.html` só quando os termos estão `vigente`, D2) com o CSS do site e só o script de tema do
 * `index.html` (texto legível sem JavaScript; o nginx tenta `$uri.html` antes do SPA). Texto inválido ou
 * `vigente` com marcador quebra o build. No desenvolvimento serve as três páginas (também os termos em
 * rascunho, para revisar), relendo os arquivos a cada pedido. Define `import.meta.env.SOPREI_LEGAL_PUBLISHED`
 * com os endereços publicados, que o site usa para mostrar os links. Sem dependência nova.
 */
function legalPages(): Plugin {
  return {
    name: 'soprei-legal-pages',
    enforce: 'post',
    config() {
      return {
        define: {
          'import.meta.env.SOPREI_LEGAL_PUBLISHED': JSON.stringify(
            publishedLegalPaths(readLegalSources()).join(','),
          ),
        },
      };
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0]?.replace(/\.html$/, '');
        const page = LEGAL_PAGES.find((item) => item.path === path);
        if (!page || (req.method !== 'GET' && req.method !== 'HEAD')) return next();
        try {
          const sources = readLegalSources();
          const doc = parseLegalDocument(page.file, sources[page.file] as string);
          const html = renderLegalPage(
            doc,
            page.path,
            {
              stylesheetHref: '/src/style.css',
              themeScript: extractThemeScript(readFileSync(indexHtmlPath, 'utf8')),
            },
            publishedLegalPaths(sources),
          );
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(req.method === 'HEAD' ? undefined : html);
        } catch (error) {
          next(error);
        }
      });
    },
    generateBundle(_options, bundle) {
      const index = Object.values(bundle).find((item) => item.fileName === 'index.html');
      if (!index || index.type !== 'asset') throw new Error('index.html não encontrado no build');
      const html = String(index.source);
      const stylesheets = [...html.matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"/g)];
      if (stylesheets.length !== 1)
        throw new Error('o build precisa de exatamente um CSS no index.html');
      const assets = {
        stylesheetHref: (stylesheets[0] as RegExpMatchArray)[1] as string,
        themeScript: extractThemeScript(html),
      };
      for (const { fileName, html: source } of buildLegalPages(readLegalSources(), assets))
        this.emitFile({ type: 'asset', fileName, source });
    },
  };
}

export default defineConfig(({ mode }) => {
  const target = loadEnv(mode, process.cwd(), '').BACKEND_PROXY_TARGET || 'http://127.0.0.1:3000';
  const url = new URL(target);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('BACKEND_PROXY_TARGET inválido');
  return {
    plugins: [react(), tailwindcss(), legalPages()],
    // Spec 040: o mammoth só é importado pelo worker do DOCX, que a varredura inicial do Vite não
    // alcança; sem isto o servidor de desenvolvimento descobre a dependência no primeiro DOCX e
    // recarrega a página. Não muda o build.
    optimizeDeps: { include: ['mammoth'] },
    server: { proxy: { '/api': { target, rewrite: (path) => path.replace(/^\/api/, '') } } },
  };
});
