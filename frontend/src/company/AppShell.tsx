import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Menu, X } from 'lucide-react';
import { Logo } from '../components/logo';
import { Sidebar, type SidebarProps } from './Sidebar';

export interface AppShellProps extends SidebarProps {
  /** Título da tela (`h1`). */
  readonly title: string;
  /** Aviso do site (erro, informação) acima do conteúdo. */
  readonly banner?: ReactNode;
  readonly children: ReactNode;
}

/**
 * Moldura da área da empresa (spec 029, plano B da D11: shell próprio, sem código de terceiros): menu
 * lateral fixo a partir de 768 px; abaixo disso, barra superior com o botão "Abrir menu" que abre o
 * mesmo conteúdo num `<dialog>` modal (foco preso, Esc fecha, o conteúdo de trás fica inerte). A
 * animação de abrir só existe sem `prefers-reduced-motion` (regra em `style.css`).
 */
export function AppShell({ title, banner, children, ...sidebar }: AppShellProps) {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLElement>('[data-nav]')?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Se a janela passar a ser larga com o painel aberto, fecha (o menu fixo assume).
  useEffect(() => {
    if (!open) return;
    const query = window.matchMedia('(min-width: 768px)');
    const onChange = () => {
      if (query.matches) setOpen(false);
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [open]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      <aside className="hidden w-64 shrink-0 border-r border-border bg-card md:block">
        <Sidebar {...sidebar} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-border bg-card px-4 py-3 md:hidden">
          <button
            ref={buttonRef}
            type="button"
            aria-label="Abrir menu"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen(true)}
            className="grid size-10 place-items-center rounded-lg border border-input text-foreground hover:bg-muted"
          >
            <Menu aria-hidden="true" className="size-5" />
          </button>
          <Logo alt="Soprei" className="w-[96px]" />
        </header>
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto grid w-full max-w-5xl gap-5 px-4 py-6 sm:px-6">
            <h1 className="m-0 font-[Manrope] text-3xl leading-tight tracking-[-0.04em] [overflow-wrap:anywhere] max-sm:text-2xl">
              {title}
            </h1>
            {banner}
            {children}
          </div>
        </main>
      </div>
      <dialog
        id={panelId}
        ref={dialogRef}
        aria-label="Menu"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onClick={(event) => {
          // Clique no fundo escurecido (o próprio `<dialog>`, fora do painel) fecha.
          if (event.target === event.currentTarget) close();
        }}
        className="mobile-menu fixed inset-y-0 left-0 m-0 h-dvh max-h-none w-[min(20rem,85vw)] max-w-none overflow-visible border-r border-border bg-card p-0 text-card-foreground backdrop:bg-foreground/50 md:hidden"
      >
        {open && (
          <div className="relative h-full">
            <button
              type="button"
              aria-label="Fechar menu"
              onClick={close}
              className="absolute right-3 top-3 z-10 grid size-9 place-items-center rounded-lg hover:bg-muted"
            >
              <X aria-hidden="true" className="size-5" />
            </button>
            <Sidebar
              {...sidebar}
              onNavigate={(next) => {
                setOpen(false);
                sidebar.onNavigate(next);
              }}
              onManage={() => {
                setOpen(false);
                sidebar.onManage();
              }}
              onSelectCompany={(id) => {
                setOpen(false);
                sidebar.onSelectCompany(id);
              }}
            />
          </div>
        )}
      </dialog>
    </div>
  );
}
