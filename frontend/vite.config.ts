import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { loadEnv } from 'vite';

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
    server: { proxy: { '/api': { target, rewrite: (path) => path.replace(/^\/api/, '') } } },
  };
});
