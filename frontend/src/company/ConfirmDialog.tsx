import { useEffect, useId, useRef } from 'react';
import { Button } from '../components/motion/button';

export interface ConfirmDialogProps {
  /** `null` = fechado. */
  readonly request: {
    readonly title: string;
    readonly text: string;
    readonly confirmLabel: string;
  } | null;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/**
 * Confirmação com o `<dialog>` nativo (`showModal`): o foco inicial vai ao botão **seguro** (Cancelar),
 * Esc fecha sem confirmar e o foco volta ao gatilho (o navegador devolve o foco ao elemento que o tinha
 * antes de abrir). O texto diz o efeito da ação.
 */
export function ConfirmDialog({ request, busy, onConfirm, onCancel }: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const textId = useId();
  const open = request !== null;

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      dialog.showModal();
      cancelRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={textId}
      // Esc (e qualquer fechamento nativo) cancela: o estado de quem chama nunca fica "aberto" sem diálogo.
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      className="m-auto w-[min(92vw,28rem)] rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-[0_20px_70px_var(--shadow)] backdrop:bg-foreground/50"
    >
      {request !== null && (
        <div className="grid gap-4">
          <h2 id={titleId} className="m-0 text-xl font-semibold">
            {request.title}
          </h2>
          <p id={textId} className="m-0 text-sm text-muted-foreground">
            {request.text}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button ref={cancelRef} variant="outline" disabled={busy} onClick={onCancel}>
              Cancelar
            </Button>
            <Button
              className="bg-destructive text-background hover:bg-destructive/90"
              disabled={busy}
              onClick={onConfirm}
            >
              {request.confirmLabel}
            </Button>
          </div>
        </div>
      )}
    </dialog>
  );
}
