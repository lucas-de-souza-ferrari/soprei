import { strict as assert } from 'node:assert';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

/**
 * Regras da página do admin (spec 044, E3): sem script nem estilo inline (a CSP do nginx da E4,
 * `script-src 'self'; style-src 'self'`, depende disso), `noindex`, e nada guardado no navegador.
 * O teste compila o app com o Vite numa pasta temporária e lê o `index.html` gerado.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const srcDir = join(root, 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

function assertNoInline(html: string, where: string) {
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    assert.match(match[1] ?? '', /\bsrc=/, `${where}: <script> sem src`);
    assert.equal((match[2] ?? '').trim(), '', `${where}: <script> com conteúdo`);
  }
  assert.doesNotMatch(html, /<style\b/i, `${where}: <style> inline`);
  assert.doesNotMatch(html, /\sstyle=/i, `${where}: atributo style`);
  assert.doesNotMatch(html, /\son[a-z]+=/i, `${where}: manipulador de evento inline`);
  assert.match(html, /<meta name="robots" content="noindex, nofollow"/, `${where}: sem noindex`);
}

describe('página do admin (spec 044, E3)', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'soprei-admin-build-'));
  after(() => rmSync(outDir, { recursive: true, force: true }));

  it('o index.html de origem não tem script nem estilo inline e pede noindex', () => {
    assertNoInline(readFileSync(join(root, 'index.html'), 'utf8'), 'index.html');
  });

  it('o código do app não usa localStorage, sessionStorage, cookie nem style inline', () => {
    for (const file of sourceFiles(srcDir)) {
      const text = readFileSync(file, 'utf8');
      for (const banned of ['localStorage', 'sessionStorage', 'document.cookie', 'indexedDB'])
        assert.equal(text.includes(banned), false, `${file}: usa ${banned}`);
      assert.doesNotMatch(text, /\bstyle=\{/, `${file}: style inline (a CSP recusa)`);
      assert.doesNotMatch(text, /dangerouslySetInnerHTML/, `${file}: HTML cru`);
      assert.doesNotMatch(
        text,
        /document\.title|history\.(push|replace)State|location\.hash/,
        `${file}: escreve no título ou na URL`,
      );
    }
  });

  it('o build não tem script nem estilo inline', { timeout: 120_000 }, async () => {
    const { build } = await import('vite');
    await build({
      root,
      configFile: join(root, 'vite.config.ts'),
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true },
    });
    const html = readFileSync(join(outDir, 'index.html'), 'utf8');
    assertNoInline(html, 'dist/index.html');
    assert.match(html, /<script type="module" crossorigin src="\/assets\/[^"]+\.js"><\/script>/);
    for (const file of readdirSync(join(outDir, 'assets')).filter((name) => name.endsWith('.js'))) {
      const js = readFileSync(join(outDir, 'assets', file), 'utf8');
      assert.equal(js.includes('localStorage'), false, `${file}: localStorage no bundle`);
      assert.equal(js.includes('sessionStorage'), false, `${file}: sessionStorage no bundle`);
    }
  });
});
