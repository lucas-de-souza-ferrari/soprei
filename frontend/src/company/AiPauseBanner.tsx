import { useState } from 'react';
import {
  Alert,
  AlertContent,
  AlertDescription,
  AlertIcon,
  AlertTitle,
} from '../components/motion/alert';
import { Button } from '../components/motion/button';
import { companyApi } from './company-api';

export interface AiPauseBannerProps {
  readonly companyId: string;
  readonly conversationId: string;
  /** Texto pronto (`pauseBannerText`), escolhido pelo site; nunca vem do servidor. */
  readonly text: string;
  /** `conversation:takeover` (OWNER, ADMIN e AGENT); sem ela a faixa só informa (VIEWER). */
  readonly canResume: boolean;
  readonly settle: (error: unknown) => string | null;
  readonly onResumed: () => void;
}

/**
 * Faixa no topo da conversa (spec 039, E4): a IA está pausada porque a equipe respondeu pelo celular.
 * "Reativar a IA" não pede confirmação (a ação é desfeita pelo próximo eco). Erro por `status` e
 * `error.code` (o `settle` de quem chama), nunca pelo texto do servidor.
 */
export function AiPauseBanner({
  companyId,
  conversationId,
  text,
  canResume,
  settle,
  onResumed,
}: AiPauseBannerProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resume = async () => {
    setBusy(true);
    setError(null);
    try {
      await companyApi.resumeAi(companyId, conversationId);
      onResumed();
    } catch (cause) {
      setError(settle(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Alert variant="info" data-testid="ai-pause-banner">
      <AlertIcon />
      <AlertContent>
        <AlertTitle>IA pausada</AlertTitle>
        <AlertDescription className="text-inherit">{text}</AlertDescription>
        {error !== null && <p className="m-0 pt-1 text-sm text-destructive">{error}</p>}
        {canResume && (
          <div className="pt-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void resume()}>
              {busy ? 'Reativando…' : 'Reativar a IA'}
            </Button>
          </div>
        )}
      </AlertContent>
    </Alert>
  );
}
