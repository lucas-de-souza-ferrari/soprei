import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AlertContent, AlertDescription, AlertIcon } from '../components/motion/alert';
import { Button } from '../components/motion/button';
import { Loader } from '../components/motion/loader';
import { Textarea } from '../components/textarea';
import { ApiError } from '../api';
import { companyApi, PERSONA_MAX_LENGTH } from './company-api';

export interface PageProps {
  readonly companyId: string;
  /** Falha com mensagem de tela (texto) ou tratada por quem chama (login, empresa trocada: `null`). */
  readonly settle: (error: unknown) => string | null;
}

type Notice = { tone: 'error' | 'success'; text: string } | null;

export const SAVE_FAILED_MESSAGE = 'Não foi possível salvar agora. Tente de novo.';
/** Status que já têm mensagem própria em `settle` (permissão, limite, indisponível). */
const OWN_MESSAGE_STATUSES = [403, 429, 502, 503];

const NUL = String.fromCharCode(0);
const HINT =
  'Descreva o tom do atendimento, o nome do negócio e o que o assistente pode e não pode dizer. O texto é usado só nas respostas desta empresa.';

/**
 * Persona do assistente, editada pela própria empresa (spec 023). O texto só trafega entre esta tela e
 * o servidor: nunca vai a URL, `localStorage`, `sessionStorage` nem `console`.
 */
export function PersonaPage({ companyId, settle }: PageProps) {
  const [loaded, setLoaded] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    setLoadError(null);
    const stamp = ++generation.current;
    companyApi
      .persona(companyId)
      .then((result) => {
        if (stamp !== generation.current) return;
        setValue(result.persona ?? '');
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (stamp !== generation.current) return;
        const text = settle(error);
        if (text !== null) setLoadError(text);
      });
    return () => {
      generation.current++;
    };
  }, [companyId, settle, attempt]);

  const save = useCallback(
    async (next: string | null): Promise<void> => {
      const stamp = ++generation.current;
      setBusy(true);
      setNotice(null);
      setFieldError(undefined);
      try {
        const result = await companyApi.savePersona(companyId, next);
        if (stamp !== generation.current) return;
        setValue(result.persona ?? '');
        setNotice({
          tone: 'success',
          text: result.persona === null ? 'Persona padrão restaurada.' : 'Persona salva.',
        });
      } catch (error) {
        if (stamp !== generation.current) return;
        // Só o 400 (texto recusado pelo servidor) fica ligado ao campo; o resto tem mensagem própria.
        if (error instanceof ApiError && error.status === 400) {
          setFieldError(
            `A persona não foi aceita. Use de 1 a ${String(PERSONA_MAX_LENGTH)} caracteres.`,
          );
          return;
        }
        const text = settle(error);
        if (text !== null) {
          const own = error instanceof ApiError && OWN_MESSAGE_STATUSES.includes(error.status);
          setNotice({ tone: 'error', text: own ? text : SAVE_FAILED_MESSAGE });
        }
      } finally {
        if (stamp === generation.current) setBusy(false);
      }
    },
    [companyId, settle],
  );

  if (loadError !== null) {
    return (
      <div className="grid gap-4">
        <div aria-live="polite">
          <Alert variant="destructive">
            <AlertIcon />
            <AlertContent>
              <AlertDescription className="text-inherit">{loadError}</AlertDescription>
            </AlertContent>
          </Alert>
        </div>
        <div>
          <Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
            Tentar de novo
          </Button>
        </div>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="grid place-items-center gap-3 py-10 text-sm text-muted-foreground">
        <Loader variant="spinner" size={28} label="Carregando a persona" />
        <span aria-hidden="true">Carregando a persona…</span>
      </div>
    );
  }

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim().length === 0) {
          setFieldError('Escreva a persona ou use "Voltar ao padrão".');
          return;
        }
        if (value.includes(NUL)) {
          setFieldError('O texto tem um caractere inválido.');
          return;
        }
        void save(value);
      }}
    >
      <div aria-live="polite">
        {notice && (
          <Alert variant={notice.tone === 'error' ? 'destructive' : 'success'}>
            <AlertIcon />
            <AlertContent>
              <AlertDescription className="text-inherit">{notice.text}</AlertDescription>
            </AlertContent>
          </Alert>
        )}
      </div>
      <Textarea
        id="persona"
        label="Persona do assistente"
        value={value}
        onChange={(next) => {
          setValue(next);
          setFieldError(undefined);
        }}
        maxLength={PERSONA_MAX_LENGTH}
        rows={10}
        hint={HINT}
        error={fieldError}
        disabled={!loaded || busy}
      />
      <p className="m-0 px-1 text-xs text-muted-foreground" aria-live="off">
        {value.length} de {PERSONA_MAX_LENGTH} caracteres
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !loaded}>
          Salvar
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy || !loaded}
          onClick={() => void save(null)}
        >
          Voltar ao padrão
        </Button>
      </div>
    </form>
  );
}
