import { Input } from './components/motion/input';
import { normalizeVerificationCode } from './verification-code';

/**
 * Campo do código de 6 dígitos: teclado numérico, preenchimento automático do código recebido por
 * mensagem e normalização a cada mudança. O `maxLength` é folgado de propósito: o navegador corta
 * a colagem antes do `onChange`, e `123 456` ou `123-456` precisam chegar inteiros para ser
 * normalizados.
 */
export function VerificationField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
}) {
  return (
    <Input
      id="verification"
      label="Código recebido por e-mail"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]*"
      maxLength={16}
      value={value}
      onChange={(next) => onChange(normalizeVerificationCode(next))}
      error={error}
      required
    />
  );
}
