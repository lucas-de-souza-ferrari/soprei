import { type ReactNode, useEffect, useId, useRef } from 'react';
import { Button } from '../components/motion/button';

export interface ModalProps {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

/**
 * Diálogo modal com o `<dialog>` nativo (`showModal`): o foco entra no diálogo (no elemento com
 * `data-autofocus`, se houver), Esc fecha e o foco volta ao gatilho. Só tokens de cor. O conteúdo só é montado enquanto aberto, então nenhum
 * texto de formulário sobra na tela depois de fechar.
 */
export function Modal({ open, title, onClose, children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // O `showModal` foca o primeiro elemento focável (o "Fechar"); quem precisar de outro marca o campo com
      // `data-autofocus` (spec 040: o formulário de contato abre com o foco no primeiro campo).
      dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    } else if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className="m-auto max-h-[90vh] w-[min(94vw,36rem)] overflow-y-auto rounded-2xl border border-border bg-card p-5 text-card-foreground shadow-[0_20px_70px_var(--shadow)] backdrop:bg-foreground/50"
    >
      {open && (
        <div className="grid gap-4">
          <div className="flex items-start justify-between gap-3">
            <h2 id={titleId} className="m-0 text-xl font-semibold">
              {title}
            </h2>
            <Button variant="outline" size="sm" onClick={onClose}>
              Fechar
            </Button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}
