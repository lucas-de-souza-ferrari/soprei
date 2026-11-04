import { Alert, AlertContent, AlertDescription, AlertIcon } from '../components/motion/alert';
import { Button } from '../components/motion/button';

export interface RetryAlertProps {
  /** Texto já escolhido pelo site (por `status` e `error.code`); nunca o texto do servidor. */
  readonly text: string;
  readonly disabled: boolean;
  readonly onRetry: () => void;
}

/** Aviso de erro com "Tentar de novo" (`role="alert"` do Alert destrutivo). */
export function RetryAlert({ text, disabled, onRetry }: RetryAlertProps) {
  return (
    <Alert variant="destructive">
      <AlertIcon />
      <AlertContent>
        <AlertDescription className="text-inherit">{text}</AlertDescription>
        <div className="pt-2">
          <Button variant="outline" size="sm" disabled={disabled} onClick={onRetry}>
            Tentar de novo
          </Button>
        </div>
      </AlertContent>
    </Alert>
  );
}
