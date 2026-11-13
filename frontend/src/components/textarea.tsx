import { type Ref, useId, type TextareaHTMLAttributes } from 'react';
import { cn } from '../lib/utils';

export interface TextareaProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'value' | 'onChange'
> {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Mensagem de erro (lida pelo leitor de tela junto do campo). */
  error?: string | undefined;
  /** Texto de apoio, ligado ao campo por `aria-describedby`. */
  hint?: string | undefined;
  /** React 19: `ref` é prop comum e vai ao `<textarea>` (para mover o foco ao campo com erro). */
  ref?: Ref<HTMLTextAreaElement>;
}

/**
 * Campo de texto longo no mesmo visual do `Input` do beUI (só tokens de cor). Não vem do registro:
 * é um `<textarea>` com rótulo visível, dica e erro ligados por `aria-describedby`.
 */
export function Textarea({
  label,
  value,
  onChange,
  error,
  hint,
  id: idProp,
  className,
  ...rest
}: TextareaProps) {
  const reactId = useId();
  const id = idProp ?? reactId;
  const describedBy =
    [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') ||
    undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="px-1 text-sm font-medium text-foreground">
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
        className={cn(
          'min-h-40 w-full resize-y rounded-2xl border border-input bg-transparent px-3.5 py-3 text-base leading-6 text-foreground caret-foreground outline-none',
          'placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring',
          error && 'border-destructive ring-1 ring-destructive',
          className,
        )}
      />
      {hint ? (
        <p id={`${id}-hint`} className="px-1 text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} role="alert" className="px-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
