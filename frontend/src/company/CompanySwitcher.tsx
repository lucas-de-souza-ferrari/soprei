import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';

export interface SwitcherCompany {
  readonly companyId: string;
  readonly name: string;
  readonly roleLabel: string;
}

export interface CompanySwitcherProps {
  readonly current: SwitcherCompany;
  readonly companies: readonly SwitcherCompany[];
  readonly disabled: boolean;
  readonly onSelect: (companyId: string) => void;
  readonly onManage: () => void;
}

/**
 * Seletor de empresa do menu lateral (spec 029). Padrão de botão de menu (`aria-haspopup="menu"`) com
 * itens `menuitemradio` (as empresas) e `menuitem` (gerenciar e criar): Enter, Espaço e seta para baixo
 * abrem; setas, Home e End movem; Enter escolhe; Esc fecha e devolve o foco ao botão; Tab e clique fora
 * fecham. O nome da empresa trunca com reticências e aparece inteiro em `title`.
 */
export function CompanySwitcher({
  current,
  companies,
  disabled,
  onSelect,
  onManage,
}: CompanySwitcherProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const items = (): HTMLElement[] =>
    Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  };

  // Ao abrir, o foco vai para a empresa atual.
  useEffect(() => {
    if (!open) return;
    const all = items();
    (all.find((item) => item.getAttribute('aria-checked') === 'true') ?? all[0])?.focus();
  }, [open]);

  // Clique fora fecha.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node))
        setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onButtonKey = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
    }
  };
  const onMenuKey = (event: KeyboardEvent) => {
    const all = items();
    const index = all.indexOf(document.activeElement as HTMLElement);
    const go = (next: number) => {
      event.preventDefault();
      all[(next + all.length) % all.length]?.focus();
    };
    if (event.key === 'ArrowDown') go(index + 1);
    else if (event.key === 'ArrowUp') go(index - 1);
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(all.length - 1);
    else if (event.key === 'Escape') {
      // Não deixa o Esc chegar ao `<dialog>` do menu do celular (que fecharia o painel inteiro).
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'Tab') setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Empresa: ${current.name}. Trocar de empresa`}
        title={current.name}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={onButtonKey}
        className="flex w-full items-center gap-2 rounded-xl border border-input bg-card px-3 py-2 text-left text-card-foreground hover:bg-muted disabled:opacity-60"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{current.name}</span>
          <span className="block truncate text-xs text-muted-foreground">{current.roleLabel}</span>
        </span>
        <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div
          id={menuId}
          ref={listRef}
          role="menu"
          aria-label="Empresas"
          onKeyDown={onMenuKey}
          className="absolute inset-x-0 top-full z-20 mt-2 grid gap-1 rounded-xl border border-border bg-card p-1 text-card-foreground shadow-[0_20px_70px_var(--shadow)]"
        >
          <div className="grid max-h-64 gap-1 overflow-y-auto">
            {companies.map((item) => {
              const selected = item.companyId === current.companyId;
              return (
                <button
                  key={item.companyId}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  title={item.name}
                  onClick={() => {
                    close(true);
                    if (!selected) onSelect(item.companyId);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{item.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {item.roleLabel}
                    </span>
                  </span>
                  {selected && <Check aria-hidden="true" className="size-4 shrink-0" />}
                </button>
              );
            })}
          </div>
          <div className="border-t border-border pt-1">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                close(false);
                onManage();
              }}
              className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-muted"
            >
              Gerenciar empresas
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                close(false);
                onManage();
              }}
              className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-muted"
            >
              Criar empresa
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
