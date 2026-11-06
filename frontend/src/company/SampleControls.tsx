import { useRef, useState } from 'react';
import { ApiError } from '../api';
import { Alert, AlertContent, AlertDescription, AlertIcon } from '../components/motion/alert';
import { Button } from '../components/motion/button';
import { ConfirmDialog } from './ConfirmDialog';
import { knowledgeApi, knowledgeMessageOf } from './knowledge-api';

export interface SampleControlsProps {
  readonly companyId: string;
  /** A empresa não tem nada cadastrado nesta tela (só então "Carregar exemplo" aparece). */
  readonly isEmpty: boolean;
  /** Há item de exemplo na lista (só então "Remover exemplo" aparece). */
  readonly hasSample: boolean;
  /** Falha com mensagem de tela (texto) ou tratada por quem chama (login, empresa trocada: `null`). */
  readonly settle: (error: unknown) => string | null;
  /** Recarrega a lista da tela depois de carregar ou remover o exemplo. */
  readonly onChanged: () => void;
}

const GENERIC = 'Não foi possível concluir agora. Tente de novo.';
const OWN_MESSAGE_STATUSES = [403, 429, 502, 503];

type Pending = 'load' | 'remove' | null;

/**
 * "Carregar exemplo" e "Remover exemplo" (spec 026, E3): dados fictícios da "Loja Exemplo" para
 * conhecer o produto. O servidor só os carrega em empresa vazia (409 `SAMPLE_REQUIRES_EMPTY` vira a
 * mensagem da tela). Sempre com confirmação e com o selo "Exemplo" nos itens. Recarregar o exemplo
 * restaura preço e quantidade originais.
 */
export function SampleControls({
  companyId,
  isEmpty,
  hasSample,
  settle,
  onChanged,
}: SampleControlsProps) {
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const generation = useRef(0);

  if (!isEmpty && !hasSample && message === null) return null;

  const run = async (kind: 'load' | 'remove'): Promise<void> => {
    const stamp = ++generation.current;
    setBusy(true);
    setMessage(null);
    try {
      if (kind === 'load') await knowledgeApi.loadSample(companyId);
      else await knowledgeApi.removeSample(companyId);
      if (stamp !== generation.current) return;
      setMessage({
        tone: 'success',
        text: kind === 'load' ? 'Exemplo carregado.' : 'Exemplo removido.',
      });
      onChanged();
    } catch (error) {
      if (stamp !== generation.current) return;
      const own = knowledgeMessageOf(error);
      // Recusado por já haver dados (outra aba cadastrou algo): relê a lista para a tela refletir a verdade.
      if (error instanceof ApiError && error.status === 409) onChanged();
      const text = own ?? settle(error);
      if (text !== null) {
        const known =
          own !== null ||
          (error instanceof ApiError && OWN_MESSAGE_STATUSES.includes(error.status));
        setMessage({ tone: 'error', text: known ? text : GENERIC });
      }
    } finally {
      if (stamp === generation.current) {
        setBusy(false);
        setPending(null);
      }
    }
  };

  return (
    <div className="grid gap-3 rounded-2xl border border-border bg-card p-4 text-card-foreground">
      <p className="m-0 text-sm text-muted-foreground">
        {isEmpty
          ? 'Quer conhecer o produto? Carregue dados de exemplo da "Loja Exemplo" (documentos e produtos fictícios).'
          : 'Há dados de exemplo nesta empresa (marcados como "Exemplo").'}
      </p>
      <div aria-live="polite">
        {message && (
          <Alert variant={message.tone === 'error' ? 'destructive' : 'success'}>
            <AlertIcon />
            <AlertContent>
              <AlertDescription className="text-inherit">{message.text}</AlertDescription>
            </AlertContent>
          </Alert>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {isEmpty && (
          <Button variant="outline" disabled={busy} onClick={() => setPending('load')}>
            Carregar exemplo
          </Button>
        )}
        {hasSample && (
          <Button variant="outline" disabled={busy} onClick={() => setPending('remove')}>
            Remover exemplo
          </Button>
        )}
      </div>
      <ConfirmDialog
        request={
          pending === null
            ? null
            : pending === 'load'
              ? {
                  title: 'Carregar o exemplo?',
                  text: 'Cria 2 documentos e 8 produtos fictícios da "Loja Exemplo", marcados como "Exemplo". Só funciona em empresa vazia e você pode removê-los depois.',
                  confirmLabel: 'Carregar',
                }
              : {
                  title: 'Remover o exemplo?',
                  text: 'Apaga os documentos de exemplo e desativa os produtos de exemplo. O que você cadastrou não muda. Carregar o exemplo de novo restaura os valores originais.',
                  confirmLabel: 'Remover',
                }
        }
        busy={busy}
        onConfirm={() => {
          if (pending !== null) void run(pending);
        }}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
