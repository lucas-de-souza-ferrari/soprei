import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { allowedPages } from './company-nav';

const frontend = new URL('../../', import.meta.url);
const SHELL_FILES = ['AppShell.tsx', 'Sidebar.tsx', 'CompanySwitcher.tsx'] as const;
const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');

test('spec 029 E1: nenhuma dependência nova no frontend (shell próprio, plano B da D11)', () => {
  const pkg = JSON.parse(readFileSync(new URL('package.json', frontend), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), [
    'clsx',
    'lucide-react',
    'motion',
    'react',
    'react-dom',
    'tailwind-merge',
    'zod',
  ]);
  for (const forbidden of ['next', 'next-themes', 'class-variance-authority'])
    assert.equal(forbidden in pkg.dependencies, false, forbidden);
  assert.equal(
    Object.keys(pkg.dependencies).some(
      (name) => name.startsWith('@radix-ui/') || name.startsWith('@duo-icons/'),
    ),
    false,
  );
  // O CLI do shadcn não rodou: não há components.json.
  assert.equal(existsSync(new URL('components.json', frontend)), false);
});

test('spec 029 E1: os arquivos do shell só importam o que o projeto já tem', () => {
  const allowed = /^(react|lucide-react|clsx|tailwind-merge|motion|\.{1,2}\/)/;
  for (const file of SHELL_FILES) {
    const imports = [...source(file).matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '');
    assert.ok(imports.length > 0, file);
    for (const target of imports) assert.match(target, allowed, `${file} importa ${target}`);
    assert.doesNotMatch(source(file), /next\/|next-themes|@duo-icons|["']use client["']/);
  }
});

test('spec 029 E1: os arquivos do shell não têm cor literal, só tokens', () => {
  const literal =
    /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch)\(|\b(?:bg|text|border|ring|from|to|via|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white)\b/;
  for (const file of SHELL_FILES) assert.doesNotMatch(source(file), literal, file);
  // E o CSS do menu do celular também.
  const css = readFileSync(new URL('src/style.css', frontend), 'utf8');
  const block = css.slice(css.indexOf('Menu lateral no celular'));
  assert.doesNotMatch(block, literal);
});

test('spec 029 E1: allowedPages mostra só as telas da permissão e na ordem do menu', () => {
  assert.deepEqual(allowedPages(['conversation:read']), ['conversas']);
  assert.deepEqual(allowedPages([]), []);
  assert.deepEqual(allowedPages(['conversation:simulate', 'conversation:read', 'schedule:read']), [
    'conversas',
    'agenda',
    'testar',
  ]);
  // A tela de configuração da agenda não é item de menu.
  assert.equal(allowedPages(['schedule:configure']).includes('agendaConfig'), false);
});

test('spec 029 E1: os componentes do shell ficam em company/', () => {
  const files = readdirSync(new URL('.', import.meta.url));
  for (const file of SHELL_FILES) assert.ok(files.includes(file), file);
});
