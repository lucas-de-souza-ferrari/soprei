import { useEffect, useRef, useState } from 'react';
import { Alert, AlertContent, AlertDescription, AlertIcon } from '../components/motion/alert';
import { Button } from '../components/motion/button';
import { Textarea } from '../components/textarea';
import { type AnswerSource, companyApi, MESSAGE_MAX_LENGTH } from './company-api';
import type { PageProps } from './PersonaPage';

interface Line {
  readonly id: number;
  readonly from: 'you' | 'assistant';
  readonly text: string;
  readonly fallback: boolean;
  /** Só na resposta do assistente (spec 026). */
  readonly sources?: readonly AnswerSource[];
}

const NOTICE =
  'É um teste: a conversa fica gravada no Soprei e, com o modelo real ligado, o texto é enviado ao provedor de IA. Nada é enviado ao WhatsApp.';
const KIND_LABELS = { document: 'documento', product: 'produto', schedule: 'agenda' } as const;

/** Linha de fontes da resposta (spec 026): só rótulos. */
export function sourcesText(sources: readonly AnswerSource[]): string {
  if (sources.length === 0) return 'Nenhuma informação da empresa usada';
  return `Fontes usadas: ${sources.map((source) => (source.kind === 'schedule' ? source.label : `${source.label} (${KIND_LABELS[source.kind]})`)).join(', ')}`;
}

const FALLBACK_MARK = 'resposta padrão (houve falha ao gerar)';

/**
 * "Testar o atendimento" (spec 023): usa o simulador existente (`POST .../messages`), com resposta
 * síncrona e `contactRef` fixo. O histórico da caixa vive só na memória desta tela; resposta que chega
 * depois de trocar de empresa (ou sair da tela) é descartada.
 */
export function TestPage({ companyId, settle }: PageProps) {
  const [text, setText] = useState('');
  const [lines, setLines] = useState<readonly Line[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const generation = useRef(0);
  const next = useRef(0);

  useEffect(() => {
    const stamp = generation;
    return () => {
      stamp.current++;
    };
  }, [companyId]);

  const send = async (): Promise<void> => {
    const message = text;
    if (message.trim().length === 0) {
      setFieldError('Escreva uma mensagem para testar.');
      return;
    }
    const stamp = ++generation.current;
    setBusy(true);
    setError(null);
    setFieldError(undefined);
    setLines((current) => [
      ...current,
      { id: next.current++, from: 'you', text: message, fallback: false },
    ]);
    setText('');
    try {
      const result = await companyApi.send(companyId, message);
      if (stamp !== generation.current) return;
      setLines((current) => [
        ...current,
        {
          id: next.current++,
          from: 'assistant',
          text: result.reply.text,
          fallback: result.reply.isFallback,
          sources: result.sources,
        },
      ]);
    } catch (failure) {
      if (stamp !== generation.current) return;
      const failureText = settle(failure);
      if (failureText !== null) setError(failureText);
    } finally {
      if (stamp === generation.current) setBusy(false);
    }
  };

  return (
    <div className="grid gap-4">
      <p className="m-0 text-sm text-muted-foreground">{NOTICE}</p>
      <div
        role="log"
        aria-live="polite"
        aria-label="Conversa de teste"
        className="grid max-h-96 gap-3 overflow-y-auto"
      >
        {lines.map((line) => (
          <div
            key={line.id}
            className={
              line.from === 'you'
                ? 'ml-auto max-w-[85%] rounded-2xl bg-bubble px-4 py-2 text-foreground'
                : 'mr-auto max-w-[85%] rounded-2xl border border-border bg-card px-4 py-2 text-card-foreground'
            }
          >
            <span className="sr-only">{line.from === 'you' ? 'Você: ' : 'Assistente: '}</span>
            <span className="[overflow-wrap:anywhere] whitespace-pre-wrap">{line.text}</span>
            {line.from === 'assistant' && line.sources !== undefined && (
              <small className="mt-1 block text-xs text-muted-foreground">
                {sourcesText(line.sources)}
              </small>
            )}
            {line.fallback && (
              <small className="mt-1 block text-xs text-muted-foreground">{FALLBACK_MARK}</small>
            )}
          </div>
        ))}
        {busy && (
          <p className="m-0 text-sm text-muted-foreground">O assistente está respondendo…</p>
        )}
      </div>
      {error && (
        <div aria-live="polite">
          <Alert variant="destructive">
            <AlertIcon />
            <AlertContent>
              <AlertDescription className="text-inherit">{error}</AlertDescription>
            </AlertContent>
          </Alert>
        </div>
      )}
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void send();
        }}
      >
        <Textarea
          id="mensagem-de-teste"
          label="Mensagem de teste"
          value={text}
          onChange={(value) => {
            setText(value);
            setFieldError(undefined);
          }}
          maxLength={MESSAGE_MAX_LENGTH}
          rows={3}
          className="min-h-24"
          error={fieldError}
        />
        <div>
          <Button type="submit" disabled={busy}>
            {busy ? 'Aguardando resposta…' : 'Enviar'}
          </Button>
        </div>
      </form>
    </div>
  );
}
