import { type KeyboardEvent, type ReactNode, useId, useRef } from 'react';

export interface SectionTab<K extends string> {
  readonly key: K;
  readonly label: string;
  readonly content: ReactNode;
}

export interface SectionTabsProps<K extends string> {
  readonly label: string;
  readonly tabs: readonly SectionTab<K>[];
  readonly active: K;
  readonly onChange: (key: K) => void;
}

/**
 * Abas acessíveis (padrão WAI-ARIA: setas, Home e End) para dividir páginas longas.
 * Só o painel ativo é montado: o estado que importa mora em quem usa o componente.
 */
export function SectionTabs<K extends string>({
  label,
  tabs,
  active,
  onChange,
}: SectionTabsProps<K>) {
  const base = useId();
  const refs = useRef(new Map<K, HTMLButtonElement>());
  const index = Math.max(
    0,
    tabs.findIndex((tab) => tab.key === active),
  );

  const move = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const last = tabs.length - 1;
    const next =
      event.key === 'ArrowRight'
        ? index === last
          ? 0
          : index + 1
        : event.key === 'ArrowLeft'
          ? index === 0
            ? last
            : index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    const target = next === null ? undefined : tabs[next];
    if (target === undefined) return;
    event.preventDefault();
    onChange(target.key);
    refs.current.get(target.key)?.focus();
  };

  const current = tabs[index];
  return (
    <div className="grid min-w-0 gap-4">
      <div
        role="tablist"
        aria-label={label}
        className="flex gap-1 overflow-x-auto border-b border-border"
      >
        {tabs.map((tab) => {
          const selected = tab.key === active;
          return (
            <button
              key={tab.key}
              ref={(element) => {
                if (element === null) refs.current.delete(tab.key);
                else refs.current.set(tab.key, element);
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${tab.key}`}
              aria-selected={selected}
              aria-controls={`${base}-panel-${tab.key}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(tab.key)}
              onKeyDown={move}
              className={`-mb-px min-h-11 shrink-0 whitespace-nowrap border-b-2 px-4 text-sm font-medium transition-colors ${
                selected
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {current !== undefined && (
        <div
          role="tabpanel"
          id={`${base}-panel-${current.key}`}
          aria-labelledby={`${base}-tab-${current.key}`}
          className="grid min-w-0 gap-5"
        >
          {current.content}
        </div>
      )}
    </div>
  );
}
