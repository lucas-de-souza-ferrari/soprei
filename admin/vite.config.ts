import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * App do admin da plataforma (spec 044, E3). Em desenvolvimento, `/api/*` vai ao backend local com o
 * prefixo removido, como o nginx faz em produção (mesma origem para o navegador: sem CORS).
 *
 * `Origin`: o proxy não reescreve o cabeçalho. O navegador manda a origem da página
 * (`http://127.0.0.1:5175`, porta fixa com `--strictPort`) e o backend local a compara com o
 * `ADMIN_ORIGIN` do `backend/.env`, que deve ter exatamente esse valor. Forjar a origem aqui faria o
 * dev aceitar escrita vinda de qualquer página.
 */
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
    plugins: [react(), tailwindcss()],
    // Sem script inline no build (CSP `script-src 'self'` do nginx, E4): o polyfill de modulepreload
    // fica fora do HTML.
    build: { modulePreload: { polyfill: false } },
    server: { proxy: { '/api': { target, rewrite: (path) => path.replace(/^\/api/, '') } } },
  };
});
