import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { allowedPages } from './company-nav';

const frontend = new URL('../../', import.meta.url);
const SHELL_FILES = [
  'AppShell.tsx',
  'CompanySwitcher.tsx',
  '../components/dashboard-shell/dashboard-shell.tsx',
  '../components/dashboard-shell/dashboard-shell.css',
] as const;
const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');

/** Dependências autorizadas pela spec 029 (D11, alternativa a), em versão exata. */
const AUTHORIZED = [
  '@radix-ui/react-alert-dialog',
  '@radix-ui/react-dropdown-menu',
  '@radix-ui/react-popover',
  '@radix-ui/react-tabs',
  'class-variance-authority',
] as const;

/** Leitores de arquivo da base de conhecimento, autorizados pela spec 040 (versão exata). */
const KNOWLEDGE_READERS = ['mammoth', 'pdfjs-dist'] as const;

test('spec 029 E1: só as dependências autorizadas entraram, em versão exata, e o CLI do shadcn não rodou', () => {
  const pkg = JSON.parse(readFileSync(new URL('package.json', frontend), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), [
    ...AUTHORIZED,
    'clsx',
    'lucide-react',
    'mammoth',
    'motion',
    'pdfjs-dist',
    'react',
    'react-dom',
    'tailwind-merge',
    'zod',
  ]);
  for (const name of [...AUTHORIZED, ...KNOWLEDGE_READERS])
    assert.match(pkg.dependencies[name] ?? '', /^\d+\.\d+\.\d+$/, name);
  for (const forbidden of ['next', 'next-themes'])
    assert.equal(forbidden in pkg.dependencies, false, forbidden);
  assert.equal(
    Object.keys(pkg.dependencies).some((name) => name.startsWith('@duo-icons/')),
    false,
  );
  assert.equal(existsSync(new URL('components.json', frontend)), false);
});

test('spec 029 E1: cada dependência autorizada é importada pelo shell copiado', () => {
  const shell = source('../components/dashboard-shell/dashboard-shell.tsx');
  for (const name of AUTHORIZED) assert.ok(shell.includes(`'${name}'`), `${name} não é importada`);
});

test('spec 029 E1: os arquivos do shell só importam o que é autorizado e não usam next, duo-icons nem "use client"', () => {
  const allowed = new RegExp(
    `^(react|lucide-react|clsx|tailwind-merge|motion/react|${AUTHORIZED.join('|')}|\\.{1,2}/)`,
  );
  for (const file of SHELL_FILES.filter((name) => name.endsWith('.tsx'))) {
    const imports = [...source(file).matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '');
    assert.ok(imports.length > 0, file);
    for (const target of imports) assert.match(target, allowed, `${file} importa ${target}`);
    assert.doesNotMatch(source(file), /next\/|next-themes|@duo-icons|["']use client["']|@\//);
  }
});

test('spec 029 E1: os arquivos do shell não têm cor literal, só tokens', () => {
  const literal =
    /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch)\(|\b(?:bg|text|border|ring|from|to|via|fill|stroke|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white)\b/;
  for (const file of SHELL_FILES) assert.doesNotMatch(source(file), literal, file);
});

test('spec 029 E1: NOTICE.md registra a origem, a data, a licença MIT e o aviso de copyright', () => {
  const notice = source('NOTICE.md');
  assert.match(notice, /obsidianui\.dev\/docs\/dashboard-shell/);
  assert.match(notice, /2026-11-05/);
  assert.match(notice, /MIT License/);
  assert.match(notice, /Copyright \(c\) 2026 ObsidianUI/);
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
