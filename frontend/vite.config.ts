import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { loadEnv } from 'vite';
import {
  extractThemeScript,
  LEGAL_PAGES,
  parseLegalDocument,
  renderLegalPage,
} from './src/legal/legal-page';

const legalDir = fileURLToPath(new URL('./src/legal/', import.meta.url));
const indexHtmlPath = fileURLToPath(new URL('./index.html', import.meta.url));

/** Lê e valida os três textos (texto inválido ou `vigente` com marcador quebra o build). */
function readLegalDocuments() {
  return LEGAL_PAGES.map((page) => ({
    page,
    doc: parseLegalDocument(page.file, readFileSync(legalDir + page.file, 'utf8')),
  }));
}

/**
 * Páginas legais estáticas (spec 032, E1): no build grava `privacidade.html`, `termos.html` e
 * `exclusao-de-dados.html` com o CSS do site e só o script de tema do `index.html` (texto legível sem
 * JavaScript; o nginx tenta `$uri.html` antes do SPA). No desenvolvimento serve as mesmas páginas, relendo os
 * arquivos a cada pedido. Sem dependência nova.
 */
function legalPages(): Plugin {
  return {
    name: 'soprei-legal-pages',
    enforce: 'post',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0]?.replace(/\.html$/, '');
        const page = LEGAL_PAGES.find((item) => item.path === path);
        if (!page || (req.method !== 'GET' && req.method !== 'HEAD')) return next();
        try {
          const doc = parseLegalDocument(page.file, readFileSync(legalDir + page.file, 'utf8'));
          const html = renderLegalPage(doc, page.path, {
            stylesheetHref: '/src/style.css',
            themeScript: extractThemeScript(readFileSync(indexHtmlPath, 'utf8')),
          });
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
      for (const { page, doc } of readLegalDocuments()) {
        this.emitFile({
          type: 'asset',
          fileName: `${page.path.slice(1)}.html`,
          source: renderLegalPage(doc, page.path, assets),
        });
      }
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
    server: { proxy: { '/api': { target, rewrite: (path) => path.replace(/^\/api/, '') } } },
  };
});
