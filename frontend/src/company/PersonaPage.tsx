import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AlertContent, AlertDescription, AlertIcon } from '../components/motion/alert';
import { Button } from '../components/motion/button';
import { Loader } from '../components/motion/loader';
import { Textarea } from '../components/textarea';
import { ApiError } from '../api';
import { companyApi, PERSONA_MAX_LENGTH } from './company-api';
import {
  hasTemplatePlaceholders,
  PERSONA_TEMPLATE,
  PLACEHOLDER_WARNING,
  type StepBridge,
} from './onboarding-steps';

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
export function PersonaPage({
  companyId,
  settle,
  onProgress,
  onDraft,
  withTemplate = false,
}: PageProps & StepBridge & { readonly withTemplate?: boolean }) {
  const [loaded, setLoaded] = useState(false);
  const [value, setValue] = useState('');
  // O que está gravado no servidor: o rascunho é a diferença (só em memória, spec 030).
  const [saved, setSaved] = useState('');
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
        setSaved(result.persona ?? '');
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
    async (next: string | null): Promise<boolean> => {
      const stamp = ++generation.current;
      setBusy(true);
      setNotice(null);
      setFieldError(undefined);
      try {
        const result = await companyApi.savePersona(companyId, next);
        if (stamp !== generation.current) return false;
        setValue(result.persona ?? '');
        setSaved(result.persona ?? '');
        onProgress?.();
        setNotice({
          tone: 'success',
          text: result.persona === null ? 'Persona padrão restaurada.' : 'Persona salva.',
        });
        return true;
      } catch (error) {
        if (stamp !== generation.current) return false;
        // Só o 400 (texto recusado pelo servidor) fica ligado ao campo; o resto tem mensagem própria.
        if (error instanceof ApiError && error.status === 400) {
          setFieldError(
            `A persona não foi aceita. Use de 1 a ${String(PERSONA_MAX_LENGTH)} caracteres.`,
          );
          return false;
        }
        const text = settle(error);
        if (text !== null) {
          const own = error instanceof ApiError && OWN_MESSAGE_STATUSES.includes(error.status);
          setNotice({ tone: 'error', text: own ? text : SAVE_FAILED_MESSAGE });
        }
        return false;
      } finally {
        if (stamp === generation.current) setBusy(false);
      }
    },
    [companyId, settle, onProgress],
  );

  // Rascunho (spec 030): texto diferente do gravado. O assistente o salva ou o descarta; só em memória.
  const dirty = loaded && value !== saved;
  const valueRef = useRef(value);
  valueRef.current = value;
  const draftSave = useRef<() => Promise<boolean>>(() => Promise.resolve(false));
  draftSave.current = (): Promise<boolean> => {
    if (value.trim().length === 0 || value.includes(NUL)) {
      setFieldError('Escreva a persona ou use "Voltar ao padrão".');
      return Promise.resolve(false);
    }
    return save(value);
  };
  useEffect(() => {
    if (onDraft === undefined) return;
    onDraft(
      dirty
        ? {
            save: () => draftSave.current(),
            hasPlaceholders: () => hasTemplatePlaceholders(valueRef.current),
          }
        : null,
    );
    return () => onDraft(null);
  }, [dirty, onDraft]);

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
      {withTemplate && hasTemplatePlaceholders(value) && (
        <p
          role="status"
          className="m-0 rounded-2xl border border-border bg-muted p-3 text-sm text-foreground"
        >
          {PLACEHOLDER_WARNING}
        </p>
      )}
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
        {withTemplate && value.length === 0 && (
          <Button
            type="button"
            variant="outline"
            disabled={busy || !loaded}
            onClick={() => {
              setValue(PERSONA_TEMPLATE);
              setFieldError(undefined);
            }}
          >
            Usar modelo
          </Button>
        )}
      </div>
    </form>
  );
}
