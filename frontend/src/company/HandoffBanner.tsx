import { useState } from 'react';
import {
  Alert,
  AlertContent,
  AlertDescription,
  AlertIcon,
  AlertTitle,
} from '../components/motion/alert';
import { Button } from '../components/motion/button';
import { notificationsApi, type OpenHandoff, reasonLabel } from './notifications-api';

export interface HandoffBannerProps {
  readonly companyId: string;
  readonly handoff: OpenHandoff;
  /** `notification:resolve` (OWNER, ADMIN e AGENT); sem ela a faixa só informa. */
  readonly canResolve: boolean;
  readonly settle: (error: unknown) => string | null;
  readonly onResolved: () => void;
}

/** Faixa no topo da conversa (spec 030): pedido de atendimento humano aberto, com "Marcar como resolvido". */
export function HandoffBanner({
  companyId,
  handoff,
  canResolve,
  settle,
  onResolved,
}: HandoffBannerProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolve = async () => {
    setBusy(true);
    setError(null);
    try {
      await notificationsApi.resolve(companyId, handoff.notificationId);
      onResolved();
    } catch (cause) {
      setError(settle(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Alert variant="warning" data-testid="handoff-banner">
      <AlertIcon />
      <AlertContent>
        <AlertTitle>Esta conversa pediu atendimento humano</AlertTitle>
        <AlertDescription className="text-inherit">{reasonLabel(handoff.reason)}.</AlertDescription>
        {error !== null && <p className="m-0 pt-1 text-sm text-destructive">{error}</p>}
        {canResolve && (
          <div className="pt-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void resolve()}>
              {busy ? 'Marcando…' : 'Marcar como resolvido'}
            </Button>
          </div>
        )}
      </AlertContent>
    </Alert>
  );
}
