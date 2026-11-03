import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  applyResolvedTheme,
  readStoredTheme,
  resolveTheme,
  systemPrefersDark,
  writeStoredTheme,
  type ResolvedTheme,
  type Theme,
} from './theme';

interface ThemeContextValue {
  /** Escolha da pessoa: claro, escuro ou sistema (padrão). */
  theme: Theme;
  /** O que de fato está aplicado agora. */
  resolvedTheme: ResolvedTheme;
  /** Aplica na hora (a classe `dark` muda antes de a função voltar), grava e atualiza a tela. */
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme());
  const [prefersDark, setPrefersDark] = useState<boolean>(() => systemPrefersDark());
  const resolvedTheme = resolveTheme(theme, prefersDark);

  // "Sistema" acompanha o sistema operacional enquanto a página está aberta.
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      setPrefersDark(query.matches);
      if (theme === 'system') applyResolvedTheme(resolveTheme('system', query.matches));
    };
    onChange();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    const dark = systemPrefersDark();
    applyResolvedTheme(resolveTheme(next, dark));
    writeStoredTheme(next);
    setPrefersDark(dark);
    setThemeState(next);
  }, []);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme precisa estar dentro de <ThemeProvider>');
  return context;
}
