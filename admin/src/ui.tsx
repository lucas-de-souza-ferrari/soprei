import { useEffect, useRef, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

/**
 * Peças de tela do admin (spec 044, E3). Só tokens de cor (style.css); nenhum `style` inline (a CSP do
 * nginx, `style-src 'self'`, recusaria).
 */

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

const BUTTON: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-foreground hover:opacity-90',
  secondary: 'border border-border-strong bg-card text-card-foreground hover:bg-muted',
  danger: 'bg-destructive text-background hover:opacity-90',
  ghost: 'text-foreground hover:bg-muted',
};

export function Button({
  children,
  variant = 'secondary',
  type = 'button',
  disabled,
  onClick,
  ariaLabel,
  ariaPressed,
}: {
  readonly children: ReactNode;
  readonly variant?: ButtonVariant;
  readonly type?: 'button' | 'submit';
  readonly disabled?: boolean;
  readonly onClick?: () => void;
  readonly ariaLabel?: string;
  readonly ariaPressed?: boolean;
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60 ${BUTTON[variant]}`}
    >
      {children}
    </button>
  );
}

export function Card({
  title,
  children,
}: {
  readonly title?: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-4 text-card-foreground">
      {title === undefined ? null : <h2 className="mb-3 text-base font-semibold">{title}</h2>}
      {children}
    </section>
  );
}

export function PageHeader({
  title,
  onRefresh,
  busy,
  children,
}: {
  readonly title: string;
  readonly onRefresh?: () => void;
  readonly busy?: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <h1 className="text-xl font-semibold">{title}</h1>
      <div className="flex flex-wrap items-center gap-2">
        {children}
        {onRefresh === undefined ? null : (
          <Button onClick={onRefresh} disabled={busy}>
            <RefreshCw aria-hidden className="size-4" />
            Atualizar
          </Button>
        )}
      </div>
    </div>
  );
}

/** Um número grande com rótulo; com `onOpen`, vira botão que leva à lista filtrada. */
export function Stat({
  label,
  value,
  onOpen,
  alert,
}: {
  readonly label: string;
  readonly value: string;
  readonly onOpen?: () => void;
  readonly alert?: boolean;
}) {
  const body = (
    <>
      <span className={`text-2xl font-semibold ${alert ? 'text-destructive' : ''}`}>{value}</span>
      <span className="text-sm text-muted-foreground">{label}</span>
    </>
  );
  const box = 'flex min-w-0 flex-col gap-1 rounded-md bg-muted p-3 text-left text-foreground';
  return onOpen === undefined ? (
    <div className={box}>{body}</div>
  ) : (
    <button type="button" onClick={onOpen} className={`${box} hover:ring-2 hover:ring-ring`}>
      {body}
    </button>
  );
}

export function StatGrid({ children }: { readonly children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">{children}</div>;
}

/** Pares rótulo e valor (quebram linha no celular, nunca rolam de lado). */
export function Facts({ items }: { readonly items: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
      {items.map(([term, value]) => (
        <div
          key={term}
          className="flex min-w-0 flex-wrap justify-between gap-x-2 border-b border-border py-1"
        >
          <dt className="text-muted-foreground">{term}</dt>
          <dd className="m-0 min-w-0 font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Alert({
  children,
  tone = 'error',
}: {
  readonly children: ReactNode;
  readonly tone?: 'error' | 'info';
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`my-3 flex items-start gap-2 rounded-md border p-3 text-sm ${
        tone === 'error'
          ? 'border-destructive text-destructive'
          : 'border-border bg-muted text-foreground'
      }`}
    >
      {tone === 'error' ? <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" /> : null}
      <span>{children}</span>
    </div>
  );
}

export function Loading() {
  return (
    <p role="status" className="text-sm text-muted-foreground">
      Carregando…
    </p>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  readonly children: ReactNode;
  readonly tone?: 'neutral' | 'bad' | 'good';
}) {
  const color =
    tone === 'bad'
      ? 'text-destructive'
      : tone === 'good'
        ? 'text-[var(--color-success)]'
        : 'text-foreground';
  return (
    <span className={`inline-block rounded bg-muted px-2 py-0.5 text-xs font-medium ${color}`}>
      {children}
    </span>
  );
}

/** Linha de lista clicável (cartão no celular e no computador; sem tabela, sem rolagem lateral). */
export function RowButton({
  onOpen,
  children,
  ariaLabel,
}: {
  readonly onOpen: () => void;
  readonly children: ReactNode;
  readonly ariaLabel: string;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-label={ariaLabel}
        className="flex w-full min-w-0 flex-col gap-1 rounded-md border border-border bg-card p-3 text-left text-card-foreground hover:bg-muted"
      >
        {children}
      </button>
    </li>
  );
}

export function Row({ children }: { readonly children: ReactNode }) {
  return (
    <li className="flex min-w-0 flex-col gap-1 rounded-md border border-border bg-card p-3 text-card-foreground">
      {children}
    </li>
  );
}

export function List({
  children,
  label,
}: {
  readonly children: ReactNode;
  readonly label: string;
}) {
  return (
    <ul aria-label={label} className="m-0 flex list-none flex-col gap-2 p-0">
      {children}
    </ul>
  );
}

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly (readonly [T, string])[];
  readonly onChange: (value: T) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className="min-h-10 rounded-md border border-input bg-card px-2 text-card-foreground"
      >
        {options.map(([key, text]) => (
          <option key={key} value={key}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Diálogo modal nativo (`<dialog>`): foco preso pelo navegador, Esc fecha, exceto com `busy` (ação em
 * andamento), quando o `cancel` é recusado. O navegador ainda pode forçar o fechamento (um segundo Esc
 * sem interação no meio); quem usa o diálogo mostra o erro da ação também fora dele.
 */
export function Dialog({
  open,
  title,
  busy = false,
  onClose,
  children,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly busy?: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby="dialog-title"
      aria-busy={busy || undefined}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
      onClose={onClose}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-lg border border-border bg-card p-4 text-card-foreground"
    >
      {open ? (
        <>
          <h2 id="dialog-title" className="mb-3 text-lg font-semibold">
            {title}
          </h2>
          {children}
        </>
      ) : null}
    </dialog>
  );
}
