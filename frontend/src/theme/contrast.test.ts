import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

/** Lê as variáveis `--nome: #rrggbb;` de um bloco `seletor { ... }` do style.css. */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`\n${selector} {`);
  assert.ok(start >= 0, `bloco ${selector} não encontrado no style.css`);
  const body = css.slice(start, css.indexOf('\n}', start));
  const result: Record<string, string> = {};
  for (const match of body.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6});/g))
    result[match[1] as string] = match[2] as string;
  return result;
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

test('o cálculo de contraste confere com valores conhecidos do WCAG', () => {
  assert.equal(Math.round(contrast('#000000', '#ffffff')), 21);
  assert.equal(contrast('#ffffff', '#ffffff'), 1);
  assert.ok(Math.abs(contrast('#767676', '#ffffff') - 4.54) < 0.01);
});

// [texto, fundo, mínimo]: 4,5 para texto; 3 para bordas de controle e anel de foco (WCAG 1.4.11).
const textPairs: [string, string][] = [
  ['foreground', 'background'],
  ['card-foreground', 'card'],
  ['foreground', 'muted'],
  ['muted-foreground', 'background'],
  ['muted-foreground', 'card'],
  ['muted-foreground', 'muted'],
  ['muted-foreground', 'tint'],
  ['muted-foreground', 'surface'],
  ['primary-foreground', 'primary'],
  ['primary', 'background'],
  ['primary', 'card'],
  ['primary', 'muted'],
  ['primary', 'tint'],
  ['primary', 'surface'],
  ['destructive', 'background'],
  ['destructive', 'card'],
  ['color-success', 'background'],
  ['color-success', 'card'],
  ['foreground', 'bubble'],
  ['primary', 'bubble'],
];
const controlPairs: [string, string][] = [
  ['input', 'background'],
  ['input', 'card'],
  ['border-strong', 'card'],
  ['ring', 'background'],
  ['ring', 'card'],
];

for (const [name, selector] of [
  ['claro', ':root'],
  ['escuro', '.dark'],
] as const) {
  const theme = tokens(selector);

  test(`tema ${name}: todos os tokens usados existem`, () => {
    for (const key of new Set([...textPairs, ...controlPairs].flat()))
      assert.ok(theme[key], `token --${key} ausente no tema ${name}`);
  });

  test(`tema ${name}: texto e fundo têm contraste mínimo de 4,5:1 (WCAG AA)`, () => {
    for (const [fg, bg] of textPairs) {
      const ratio = contrast(theme[fg] as string, theme[bg] as string);
      assert.ok(ratio >= 4.5, `${fg} sobre ${bg} no tema ${name}: ${ratio.toFixed(2)}:1`);
    }
  });

  test(`tema ${name}: bordas de campo e foco são visíveis (3:1)`, () => {
    for (const [fg, bg] of controlPairs) {
      const ratio = contrast(theme[fg] as string, theme[bg] as string);
      assert.ok(ratio >= 3, `${fg} sobre ${bg} no tema ${name}: ${ratio.toFixed(2)}:1`);
    }
  });
}

test('os dois temas declaram os mesmos tokens', () => {
  assert.deepEqual(Object.keys(tokens('.dark')).sort(), Object.keys(tokens(':root')).sort());
});
