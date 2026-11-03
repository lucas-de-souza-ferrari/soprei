// Lógica pura do tema (sem React), para ser testada sem navegador.
// A mesma regra roda, em forma mínima, no <head> do index.html antes da primeira pintura.

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'soprei-theme';
export const THEMES: readonly Theme[] = ['light', 'dark', 'system'];

/** Valor desconhecido (ou ausente) vale "sistema". */
export function parseTheme(value: unknown): Theme {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Acessar localStorage pode lançar (janela privada, dados do site bloqueados).
    return null;
  }
}

export function readStoredTheme(storage: StorageLike | null = browserStorage()): Theme {
  try {
    return parseTheme(storage?.getItem(THEME_STORAGE_KEY) ?? null);
  } catch {
    return 'system';
  }
}

/** Devolve false quando não foi possível gravar; o tema continua valendo na página. */
export function writeStoredTheme(
  theme: Theme,
  storage: StorageLike | null = browserStorage(),
): boolean {
  try {
    if (!storage) return false;
    storage.setItem(THEME_STORAGE_KEY, theme);
    return true;
  } catch {
    return false;
  }
}

export function systemPrefersDark(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

export function resolveTheme(theme: Theme, prefersDark: boolean): ResolvedTheme {
  return theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;
}

/** Aplica a classe `dark` (e o `color-scheme`) no elemento raiz. */
export function applyResolvedTheme(
  resolved: ResolvedTheme,
  root: HTMLElement = document.documentElement,
): void {
  root.classList.toggle('dark', resolved === 'dark');
  root.style.colorScheme = resolved;
}
