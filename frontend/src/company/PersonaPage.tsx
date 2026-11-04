import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AlertContent, AlertDescription, AlertIcon } from '../components/motion/alert';
import { Button } from '../components/motion/button';
import { Loader } from '../components/motion/loader';
import { Textarea } from '../components/textarea';
import { companyApi, GENERIC_MESSAGE, PERSONA_MAX_LENGTH } from './company-api';

export interface PageProps {
  readonly companyId: string;
  /** Falha com mensagem de tela (texto) ou tratada por quem chama (login, empresa trocada: `null`). */
  readonly settle: (error: unknown) => string | null;
}

type Notice = { tone: 'error' | 'success'; text: string } | null;

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
  const generation = useRef(0);

  useEffect(() => {
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
        if (text !== null) setNotice({ tone: 'error', text });
      });
    return () => {
      generation.current++;
    };
  }, [companyId, settle]);

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
        const text = settle(error);
        if (text !== null) {
          // 400: o texto não foi aceito; a mensagem fica ligada ao campo.
          if (text === GENERIC_MESSAGE) {
            setFieldError(
              `A persona não foi aceita. Use de 1 a ${String(PERSONA_MAX_LENGTH)} caracteres.`,
            );
          } else {
            setNotice({ tone: 'error', text });
          }
        }
      } finally {
        if (stamp === generation.current) setBusy(false);
      }
    },
    [companyId, settle],
  );

  if (!loaded && notice === null) {
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
