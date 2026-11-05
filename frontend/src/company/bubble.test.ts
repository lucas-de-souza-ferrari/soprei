import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('spec 029 E3: Conversas e Testar usam o componente de bolha, sem balão escrito à mão', () => {
  for (const file of ['ConversationPage.tsx', 'TestPage.tsx']) {
    const source = read(file);
    assert.match(source, /components\/motion\/message-bubble/, file);
    assert.match(source, /<MessageBubble\b/, file);
    assert.doesNotMatch(source, /bg-bubble/, file);
    assert.match(source, /dir="auto"/, file);
  }
});

test('spec 029 E3: o componente copiado só importa o que o projeto já tem e não tem cor literal', () => {
  const source = read('../components/motion/message-bubble.tsx');
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '');
  assert.ok(imports.length > 0);
  for (const target of imports)
    assert.match(
      target,
      /^(react|motion\/react|clsx|tailwind-merge|lucide-react|\.{1,2}\/)/,
      target,
    );
  assert.doesNotMatch(source, /["']use client["']|@\/|#[0-9a-fA-F]{3,8}\b|\b(?:rgb|hsl|oklch)\(/);
  // Texto puro: o componente nunca injeta HTML.
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|innerHTML/);
  assert.doesNotMatch(
    read('ConversationPage.tsx') + read('TestPage.tsx'),
    /dangerouslySetInnerHTML/,
  );
});

test('spec 029 E3: NOTICE.md registra o slug, a data e a licença do componente', () => {
  const notice = read('../components/motion/NOTICE.md');
  assert.match(notice, /message-bubble/);
  assert.match(notice, /2026-11-05/);
  assert.match(notice, /MIT/);
});
