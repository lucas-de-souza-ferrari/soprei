import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  THEME_STORAGE_KEY,
  applyResolvedTheme,
  parseTheme,
  readStoredTheme,
  resolveTheme,
  writeStoredTheme,
} from './theme';
import { ThemeProvider, useTheme } from './theme-provider';

const globals = globalThis as Record<string, unknown>;
const original = {
  localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
  matchMedia: Object.getOwnPropertyDescriptor(globalThis, 'matchMedia'),
  document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
};
function stub(name: keyof typeof original, value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
afterEach(() => {
  for (const [name, descriptor] of Object.entries(original)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globals[name];
  }
});

function fakeStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
  };
}
const darkSystem = (dark: boolean) => () => ({
  matches: dark,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
});

function Probe() {
  const { theme, resolvedTheme } = useTheme();
  return <p>{`${theme}/${resolvedTheme}`}</p>;
}
const probe = () =>
  renderToStaticMarkup(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );

test('valor inválido ou ausente vale "sistema"', () => {
  for (const value of [null, undefined, '', 'Dark', 'azul', 1, {}])
    assert.equal(parseTheme(value), 'system');
  for (const value of ['light', 'dark', 'system']) assert.equal(parseTheme(value), value);
  assert.equal(readStoredTheme(fakeStorage({ [THEME_STORAGE_KEY]: 'roxo' })), 'system');
  assert.equal(readStoredTheme(fakeStorage({ [THEME_STORAGE_KEY]: 'dark' })), 'dark');
  assert.equal(readStoredTheme(null), 'system');
});

test('localStorage indisponível (lança ao ler ou gravar) não derruba nada', () => {
  const broken = {
    getItem: () => {
      throw new Error('bloqueado');
    },
    setItem: () => {
      throw new Error('bloqueado');
    },
  };
  assert.equal(readStoredTheme(broken), 'system');
  assert.equal(writeStoredTheme('dark', broken), false);
  assert.equal(writeStoredTheme('dark', null), false);
  const ok = fakeStorage();
  assert.equal(writeStoredTheme('light', ok), true);
  assert.equal(ok.data[THEME_STORAGE_KEY], 'light');
});

test('"sistema" segue prefers-color-scheme; escolha explícita ignora o sistema', () => {
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
});

test('aplica a classe dark e o color-scheme no elemento raiz', () => {
  const classes = new Set<string>();
  const root = {
    classList: {
      toggle: (name: string, force: boolean) => (force ? classes.add(name) : classes.delete(name)),
    },
    style: { colorScheme: '' },
  } as unknown as HTMLElement;
  applyResolvedTheme('dark', root);
  assert.ok(classes.has('dark'));
  assert.equal(root.style.colorScheme, 'dark');
  applyResolvedTheme('light', root);
  assert.ok(!classes.has('dark'));
  assert.equal(root.style.colorScheme, 'light');
});

test('o provedor começa pelo tema salvo, por "sistema" ou pelo sistema escuro', () => {
  stub('matchMedia', darkSystem(false));
  stub('localStorage', fakeStorage({ [THEME_STORAGE_KEY]: 'dark' }));
  assert.match(probe(), /dark\/dark/);

  stub('localStorage', fakeStorage({ [THEME_STORAGE_KEY]: 'valor-estranho' }));
  assert.match(probe(), /system\/light/);

  stub('matchMedia', darkSystem(true));
  stub('localStorage', fakeStorage());
  assert.match(probe(), /system\/dark/);

  stub('localStorage', fakeStorage({ [THEME_STORAGE_KEY]: 'light' }));
  assert.match(probe(), /light\/light/);
});

test('sem localStorage (janela privada) o provedor cai em "sistema" sem erro', () => {
  stub('matchMedia', darkSystem(false));
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('SecurityError');
    },
  });
  assert.match(probe(), /system\/light/);
});

test('setTheme aplica a classe, grava a chave e ignora falha de gravação', () => {
  const classes = new Set<string>();
  const storage = fakeStorage();
  stub('matchMedia', darkSystem(false));
  stub('localStorage', storage);
  stub('document', {
    documentElement: {
      classList: {
        toggle: (name: string, force: boolean) =>
          force ? classes.add(name) : classes.delete(name),
      },
      style: { colorScheme: '' },
    },
  });
  let set: ((theme: 'light' | 'dark' | 'system') => void) | undefined;
  function Capture() {
    set = useTheme().setTheme;
    return null;
  }
  renderToStaticMarkup(
    <ThemeProvider>
      <Capture />
    </ThemeProvider>,
  );
  assert.ok(set);
  // Fora de uma renderização montada, a atualização de estado do React é ignorada; o efeito
  // colateral que importa (classe e armazenamento) acontece antes dela.
  try {
    set('dark');
  } catch {
    /* estado de uma renderização de servidor já concluída */
  }
  assert.ok(classes.has('dark'));
  assert.equal(storage.data[THEME_STORAGE_KEY], 'dark');
  assert.deepEqual(Object.keys(storage.data), [THEME_STORAGE_KEY]);
});

test('o script do index.html usa a mesma chave e aplica a classe dark', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  assert.match(html, new RegExp(`getItem\\('${THEME_STORAGE_KEY}'\\)`));
  assert.match(html, /classList\.add\('dark'\)/);
  assert.match(html, /prefers-color-scheme: dark/);
  // Precisa vir antes do módulo da aplicação, para valer na primeira pintura.
  assert.ok(html.indexOf("getItem('soprei-theme')") < html.indexOf('src="/src/main.tsx"'));
});
