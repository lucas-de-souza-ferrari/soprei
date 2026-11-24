import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * Contraste do admin (spec 044, E3): os tokens são cópia dos do site e cada par texto/fundo usado pelas
 * telas do admin precisa de 4,5:1 (bordas de controle e foco, 3:1) nos dois temas.
 */
const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');

/** Lê as variáveis `--nome: #rrggbb;` do primeiro bloco `:root {` a partir de `from`. */
function tokensAt(from: number): Record<string, string> {
  const start = css.indexOf(':root {', from);
  assert.ok(start >= 0, 'bloco :root não encontrado no style.css');
  const body = css.slice(start, css.indexOf('}', start));
  const result: Record<string, string> = {};
  for (const match of body.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6});/g))
    result[match[1] as string] = match[2] as string;
  return result;
}

const darkMedia = css.indexOf('@media (prefers-color-scheme: dark)');
const THEMES = {
  claro: tokensAt(0),
  escuro: tokensAt(darkMedia),
} as const;

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

test('o tema escuro vem só do prefers-color-scheme (sem classe, sem escolha guardada)', () => {
  assert.ok(darkMedia > 0, 'falta o bloco @media (prefers-color-scheme: dark)');
  assert.equal(css.includes('.dark'), false);
  assert.equal(css.includes('@custom-variant dark'), false);
});

test('o cálculo de contraste confere com valores conhecidos do WCAG', () => {
  assert.equal(Math.round(contrast('#000000', '#ffffff')), 21);
  assert.ok(Math.abs(contrast('#767676', '#ffffff') - 4.54) < 0.01);
});

test('os tokens de cor são os mesmos do site (cópia, sem divergência)', () => {
  const site = readFileSync(new URL('../../frontend/src/style.css', import.meta.url), 'utf8');
  const siteBlock = (selector: string) => {
    const start = site.indexOf(`\n${selector} {`);
    const body = site.slice(start, site.indexOf('\n}', start));
    return Object.fromEntries(
      [...body.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6,8});/g)].map((m) => [m[1], m[2]]),
    );
  };
  for (const [name, selector] of [
    ['claro', ':root'],
    ['escuro', '.dark'],
  ] as const) {
    const ours = THEMES[name];
    const theirs = siteBlock(selector);
    for (const [key, value] of Object.entries(ours))
      assert.equal(value, theirs[key], `--${key} no tema ${name} difere do site`);
  }
});

// Pares usados pelas telas do admin: [texto, fundo].
const textPairs: [string, string][] = [
  ['foreground', 'background'], // página, títulos
  ['card-foreground', 'card'], // cartões, linhas de lista, diálogo, campos
  ['foreground', 'muted'], // números da Visão geral, selos, menu ativo
  ['muted-foreground', 'background'], // texto de apoio fora de cartão
  ['muted-foreground', 'card'], // texto de apoio em cartão, menu inativo, e-mail do cabeçalho
  ['muted-foreground', 'muted'], // rótulo dos números
  ['primary-foreground', 'primary'], // botão principal (Entrar, Reativar)
  ['background', 'destructive'], // botão Suspender
  ['destructive', 'background'], // alerta de erro fora de cartão
  ['destructive', 'card'], // alerta de erro no cartão e no diálogo
  ['destructive', 'muted'], // número em alerta e selo "Suspensa"
  ['color-success', 'muted'], // selo "No ar", "Confirmada", "Pago"
];
const controlPairs: [string, string][] = [
  ['input', 'card'], // borda dos campos
  ['border-strong', 'card'], // borda dos botões secundários
  ['ring', 'background'], // foco
  ['ring', 'card'],
  ['ring', 'muted'], // contorno do número clicável
];

for (const [name, theme] of Object.entries(THEMES)) {
  test(`tema ${name}: todos os tokens usados existem`, () => {
    for (const key of new Set([...textPairs, ...controlPairs].flat()))
      assert.ok(theme[key], `token --${key} ausente no tema ${name}`);
  });

  test(`tema ${name}: texto e fundo têm contraste mínimo de 4,5:1`, () => {
    for (const [fg, bg] of textPairs) {
      const ratio = contrast(theme[fg] as string, theme[bg] as string);
      assert.ok(ratio >= 4.5, `${fg} sobre ${bg} no tema ${name}: ${ratio.toFixed(2)}:1`);
    }
  });

  test(`tema ${name}: bordas de campo e foco têm 3:1`, () => {
    for (const [fg, bg] of controlPairs) {
      const ratio = contrast(theme[fg] as string, theme[bg] as string);
      assert.ok(ratio >= 3, `${fg} sobre ${bg} no tema ${name}: ${ratio.toFixed(2)}:1`);
    }
  });
}

test('os dois temas declaram os mesmos tokens', () => {
  assert.deepEqual(Object.keys(THEMES.escuro).sort(), Object.keys(THEMES.claro).sort());
});
