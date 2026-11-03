// Adaptado de beui.dev/components/motion/theme-toggle (ver NOTICE.md): em vez do `next-themes`,
// usa o hook próprio (`../../theme/theme-provider`) e alterna entre as três escolhas do Soprei
// (sistema, claro, escuro). A animação de View Transition do beUI foi mantida.

import { Monitor, Moon, Sun } from 'lucide-react';
import { ActionSwapIcon } from './action-swap';
import { Button } from './button';
import { EASE_OUT_CSS } from '../../lib/ease';
import { cn } from '../../lib/utils';
import type { Theme } from '../../theme/theme';
import { useTheme } from '../../theme/theme-provider';

export type ThemeVariant = 'rectangle' | 'circle' | 'circle-blur' | 'blinds';

export type RectStart =
  'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center' | 'bottom-up';

export interface ThemeToggleProps {
  className?: string;
  /** Animation variant. Default: "circle". */
  variant?: ThemeVariant;
  /** Origin direction for the reveal. Default: "top-right". */
  start?: RectStart;
  iconClassName?: string;
}

const VT_STYLE_ID = 'beui-theme-toggle-vt';

// View transitions animate in CSS, not motion springs, so easing here is
// either EASE_OUT_CSS or a keyword. The circle variants keep the Material
// standard curve because their reveal expands symmetrically rather than
// decelerating. Durations differ per variant to match native OS mode switches.
const VT_CSS = `
html[data-beui-vt="rect"]::view-transition-old(root) {
  animation: none;
  mix-blend-mode: normal;
}
html[data-beui-vt="rect"]::view-transition-new(root) {
  mix-blend-mode: normal;
  animation: beui-rect-reveal 400ms ease-out;
}
html[data-beui-vt="circle"]::view-transition-old(root),
html[data-beui-vt="circle-blur"]::view-transition-old(root) {
  animation: none;
  mix-blend-mode: normal;
}
html[data-beui-vt="circle"]::view-transition-new(root) {
  mix-blend-mode: normal;
  animation: beui-circle-reveal 700ms cubic-bezier(0.4, 0, 0.2, 1);
}
html[data-beui-vt="circle-blur"]::view-transition-new(root) {
  mix-blend-mode: normal;
  animation: beui-circle-blur-reveal 700ms cubic-bezier(0.4, 0, 0.2, 1);
}
html[data-beui-vt="blinds"]::view-transition-old(root) {
  animation: none;
  mix-blend-mode: normal;
}
@property --beui-vt-slat {
  syntax: "<length>";
  inherits: false;
  initial-value: 72px;
}
html[data-beui-vt="blinds"]::view-transition-new(root) {
  mix-blend-mode: normal;
  mask-image: linear-gradient(
    90deg,
    #000 0 var(--beui-vt-slat),
    transparent calc(var(--beui-vt-slat) + 20px)
  );
  mask-size: 72px 100%;
  mask-repeat: repeat;
  animation: beui-blinds-reveal 700ms ${EASE_OUT_CSS};
}
@keyframes beui-rect-reveal {
  from { clip-path: var(--beui-vt-from, inset(100% 0 0 0)); }
  to   { clip-path: inset(0 0 0 0); }
}
@keyframes beui-circle-reveal {
  from { clip-path: circle(0% at var(--beui-vt-origin, 50% 100%)); }
  to   { clip-path: circle(150% at var(--beui-vt-origin, 50% 100%)); }
}
@keyframes beui-circle-blur-reveal {
  from { clip-path: circle(0% at var(--beui-vt-origin, 50% 100%)); filter: blur(8px); }
  to   { clip-path: circle(150% at var(--beui-vt-origin, 50% 100%)); filter: blur(0px); }
}
@keyframes beui-blinds-reveal {
  from { --beui-vt-slat: -20px; }
  to   { --beui-vt-slat: 72px; }
}
`;

const RECT_FROM: Record<RectStart, string> = {
  'top-left': 'inset(0 100% 100% 0)',
  'top-right': 'inset(0 0 100% 100%)',
  'bottom-left': 'inset(100% 100% 0 0)',
  'bottom-right': 'inset(100% 0 0 100%)',
  center: 'inset(50% 50% 50% 50%)',
  'bottom-up': 'inset(100% 0 0 0)',
};

const CIRCLE_ORIGIN: Record<RectStart, string> = {
  'top-left': '0% 0%',
  'top-right': '100% 0%',
  'bottom-left': '0% 100%',
  'bottom-right': '100% 100%',
  center: '50% 50%',
  'bottom-up': '50% 100%',
};

const NEXT_THEME: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_LABEL: Record<Theme, string> = {
  system: 'Sistema',
  light: 'Claro',
  dark: 'Escuro',
};

function ensureTransitionStyles() {
  if (document.getElementById(VT_STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = VT_STYLE_ID;
  el.textContent = VT_CSS;
  document.head.appendChild(el);
}

type TransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => { finished: Promise<void> };
};

export function useThemeToggle({
  variant = 'circle',
  start = 'top-right',
}: { variant?: ThemeVariant; start?: RectStart } = {}) {
  const { theme, setTheme } = useTheme();
  const next = NEXT_THEME[theme];

  const toggle = () => {
    const doc = document as TransitionDocument;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // `setTheme` aplica a classe `dark` de forma síncrona, como a View Transition exige.
    if (reduce || typeof doc.startViewTransition !== 'function') {
      setTheme(next);
      return;
    }

    ensureTransitionStyles();
    const root = document.documentElement;
    if (variant === 'rectangle') {
      root.style.setProperty('--beui-vt-from', RECT_FROM[start]);
      root.dataset.beuiVt = 'rect';
    } else if (variant === 'blinds') {
      root.dataset.beuiVt = 'blinds';
    } else {
      root.style.setProperty('--beui-vt-origin', CIRCLE_ORIGIN[start]);
      root.dataset.beuiVt = variant;
    }

    const transition = doc.startViewTransition(() => setTheme(next));
    void transition.finished.finally(() => {
      delete root.dataset.beuiVt;
    });
  };

  return { theme, next, toggle };
}

const ICON: Record<Theme, typeof Sun> = { system: Monitor, light: Sun, dark: Moon };

export function ThemeToggle({
  variant = 'circle',
  start = 'top-right',
  className,
  iconClassName,
}: ThemeToggleProps) {
  const { theme, next, toggle } = useThemeToggle({ variant, start });
  const Icon = ICON[theme];

  return (
    <Button
      variant="outline"
      size="icon"
      aria-label={`Tema: ${THEME_LABEL[theme]}. Mudar para ${THEME_LABEL[next]}`}
      title={`Tema: ${THEME_LABEL[theme]}`}
      data-theme-choice={theme}
      onClick={toggle}
      className={cn('size-10 rounded-full', className)}
    >
      <ActionSwapIcon value={theme} animation="blur" className={iconClassName}>
        <Icon className={iconClassName ?? 'size-[18px]'} />
      </ActionSwapIcon>
    </Button>
  );
}
