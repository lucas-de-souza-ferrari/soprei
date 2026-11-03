import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { App } from './App';

test('apresenta o produto e liga a navegação às seções existentes', () => {
  const html = renderToStaticMarkup(<App />);
  assert.match(html, /Uma conversa/);
  assert.match(html, /EXEMPLO ILUSTRATIVO/);
  for (const id of ['inicio', 'conteudo', 'como-funciona', 'possibilidades']) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.match(html, new RegExp(`href="#${id}"`));
  }
  assert.doesNotMatch(html, /<form|accessToken|refreshToken/);
});

test('mantém navegação acessível e respeita movimento reduzido', () => {
  const html = renderToStaticMarkup(<App />);
  assert.match(html, /aria-label="Navegação principal"/);
  assert.match(html, /Pular para o conteúdo/);
  assert.match(html, /alt="Soprei"/);
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /scroll-behavior:\s*auto/);
});
