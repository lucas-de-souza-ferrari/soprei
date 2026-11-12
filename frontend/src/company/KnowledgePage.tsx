import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AlertContent, AlertDescription, AlertIcon } from '../components/motion/alert';
import { Button } from '../components/motion/button';
import { Input } from '../components/motion/input';
import { Loader } from '../components/motion/loader';
import { Textarea } from '../components/textarea';
import { ApiError } from '../api';
import { ConfirmDialog } from './ConfirmDialog';
import {
  KNOWLEDGE_CONTENT_MAX,
  KNOWLEDGE_STALE_MESSAGE,
  KNOWLEDGE_TITLE_MAX,
  type KnowledgeDocumentItem,
  knowledgeApi,
  knowledgeMessageOf,
} from './knowledge-api';
import {
  checkFileName,
  checkFileSize,
  decodeTextFile,
  documentFormProblem,
  FILE_PROBLEM_MESSAGES,
  KNOWLEDGE_PRIVACY_NOTICE,
  titleFromFileName,
} from './knowledge-rules';
import type { StepBridge } from './onboarding-steps';
import type { PageProps } from './PersonaPage';
import { RetryAlert } from './RetryAlert';
import { SampleControls } from './SampleControls';

type Notice = { tone: 'error' | 'success'; text: string } | null;

export const SAVE_FAILED = 'Não foi possível salvar agora. Tente de novo.';
const OWN_MESSAGE_STATUSES = [403, 429, 502, 503];

/** Selo de texto (nunca só cor). Cores só por tokens, já cobertos no teste de contraste. */
function Chip({ children }: { children: string }) {
  return (
    <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      {children}
    </span>
  );
}

function readFile(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error('leitura'));
    };
    reader.onerror = () => reject(new Error('leitura'));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Base de conhecimento da IA (spec 026): documentos de texto da empresa. O título e o texto só vivem
 * no estado desta tela (nada em URL, armazenamento do navegador nem log); o servidor
 * devolve só tamanho, trechos e pré-visualização. Resposta que chega depois de trocar de empresa é
 * descartada.
 */
export function KnowledgePage({
  companyId,
  settle,
  canSample,
  onProgress,
  onDraft,
}: PageProps & StepBridge & { readonly canSample: boolean }) {
  const [items, setItems] = useState<KnowledgeDocumentItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [fileNote, setFileNote] = useState<string | undefined>(undefined);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, setPending] = useState<KnowledgeDocumentItem | null>(null);
  const generation = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLoadError(null);
    const stamp = ++generation.current;
    knowledgeApi
      .documents(companyId)
      .then((page) => {
        if (stamp !== generation.current) return;
        setItems([...page.items]);
        setNext(page.nextCursor);
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

  const failure = useCallback(
    (error: unknown): void => {
      const own = knowledgeMessageOf(error);
      if (own !== null) {
        setNotice({ tone: 'error', text: own });
        return;
      }
      const text = settle(error);
      if (text !== null) {
        const known = error instanceof ApiError && OWN_MESSAGE_STATUSES.includes(error.status);
        setNotice({ tone: 'error', text: known ? text : SAVE_FAILED });
      }
    },
    [settle],
  );

  const add = async (): Promise<boolean> => {
    const problem = documentFormProblem(title, content);
    if (problem !== null) {
      setFieldError(problem);
      return false;
    }
    const stamp = ++generation.current;
    setBusy(true);
    setNotice(null);
    setFieldError(undefined);
    try {
      const created = await knowledgeApi.create(companyId, { title: title.trim(), content });
      if (stamp !== generation.current) return false;
      setItems((current) => [created, ...current]);
      setTitle('');
      setContent('');
      setFileNote(undefined);
      if (fileInput.current !== null) fileInput.current.value = '';
      setNotice({ tone: 'success', text: 'Documento adicionado. A IA já pode usá-lo.' });
      onProgress?.();
      return true;
    } catch (error) {
      if (stamp !== generation.current) return false;
      failure(error);
      return false;
    } finally {
      if (stamp === generation.current) setBusy(false);
    }
  };

  // Rascunho (spec 030): título ou texto ainda não adicionados; só em memória.
  const dirty = title.trim().length > 0 || content.trim().length > 0;
  const draftAdd = useRef<() => Promise<boolean>>(() => Promise.resolve(false));
  draftAdd.current = add;
  useEffect(() => {
    if (onDraft === undefined) return;
    onDraft(dirty ? { save: () => draftAdd.current() } : null);
    return () => onDraft(null);
  }, [dirty, onDraft]);

  const remove = async (document: KnowledgeDocumentItem): Promise<void> => {
    const stamp = ++generation.current;
    setBusy(true);
    setNotice(null);
    try {
      await knowledgeApi.remove(companyId, document.id);
      if (stamp !== generation.current) return;
      setItems((current) => current.filter((item) => item.id !== document.id));
      setNotice({ tone: 'success', text: 'Documento apagado.' });
      onProgress?.();
    } catch (error) {
      if (stamp !== generation.current) return;
      if (error instanceof ApiError && error.status === 404) {
        // Já não existe (apagado em outra aba): tira da lista em vez de tratar como empresa trocada.
        setItems((current) => current.filter((item) => item.id !== document.id));
        setNotice({ tone: 'error', text: KNOWLEDGE_STALE_MESSAGE });
      } else {
        failure(error);
      }
    } finally {
      if (stamp === generation.current) {
        setBusy(false);
        setPending(null);
      }
    }
  };

  const loadMore = async (): Promise<void> => {
    if (next === null) return;
    const stamp = ++generation.current;
    setBusy(true);
    try {
      const page = await knowledgeApi.documents(companyId, next);
      if (stamp !== generation.current) return;
      setItems((current) => [...current, ...page.items]);
      setNext(page.nextCursor);
    } catch (error) {
      if (stamp !== generation.current) return;
      failure(error);
    } finally {
      if (stamp === generation.current) setBusy(false);
    }
  };

  const onFile = async (file: File | undefined): Promise<void> => {
    setFileNote(undefined);
    if (file === undefined) return;
    const reject = (message: string): void => {
      setFileNote(message);
      if (fileInput.current !== null) fileInput.current.value = '';
    };
    const nameProblem = checkFileName(file.name);
    if (nameProblem !== null) return reject(FILE_PROBLEM_MESSAGES[nameProblem]);
    const sizeProblem = checkFileSize(file.size);
    if (sizeProblem !== null) return reject(FILE_PROBLEM_MESSAGES[sizeProblem]);
    try {
      const decoded = decodeTextFile(await readFile(file));
      if ('problem' in decoded) return reject(FILE_PROBLEM_MESSAGES[decoded.problem]);
      setContent(decoded.text);
      setFieldError(undefined);
      if (title.trim().length === 0) setTitle(titleFromFileName(file.name));
    } catch {
      reject(FILE_PROBLEM_MESSAGES['not-utf8']);
    }
  };

  if (loadError !== null) {
    return (
      <RetryAlert
        text={loadError}
        disabled={false}
        onRetry={() => {
          setAttempt((value) => value + 1);
        }}
      />
    );
  }

  if (!loaded) {
    return (
      <div className="grid place-items-center gap-3 py-10 text-sm text-muted-foreground">
        <Loader variant="spinner" size={28} label="Carregando os documentos" />
        <span aria-hidden="true">Carregando os documentos…</span>
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      <p className="m-0 rounded-2xl border border-border bg-muted p-3 text-sm text-foreground">
        {KNOWLEDGE_PRIVACY_NOTICE}
      </p>
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

      {canSample && (
        <SampleControls
          companyId={companyId}
          isEmpty={items.length === 0}
          hasSample={items.some((item) => item.isSample)}
          settle={settle}
          onChanged={() => {
            setAttempt((value) => value + 1);
            onProgress?.();
          }}
        />
      )}

      <form
        className="grid gap-3"
        aria-label="Adicionar documento"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void add();
        }}
      >
        <h2 className="m-0 text-xl font-semibold">Adicionar documento</h2>
        <Input
          label="Título do documento"
          value={title}
          maxLength={KNOWLEDGE_TITLE_MAX}
          onChange={(value) => {
            setTitle(value);
            setFieldError(undefined);
          }}
        />
        <Textarea
          id="texto-do-documento"
          label="Texto do documento"
          value={content}
          onChange={(value) => {
            setContent(value);
            setFieldError(undefined);
          }}
          maxLength={KNOWLEDGE_CONTENT_MAX}
          rows={8}
          hint="Cole o texto (política de trocas, horários, perguntas frequentes...) ou escolha um arquivo .txt ou .md de até 200 KB."
          error={fieldError}
          disabled={busy}
        />
        <div className="grid gap-1">
          <label htmlFor="arquivo-do-documento" className="px-1 text-sm font-medium">
            Ou escolha um arquivo de texto
          </label>
          <input
            ref={fileInput}
            id="arquivo-do-documento"
            type="file"
            accept=".txt,.md,.markdown,text/plain,text/markdown"
            aria-describedby={fileNote === undefined ? undefined : 'arquivo-do-documento-erro'}
            disabled={busy}
            onChange={(event) => void onFile(event.target.files?.[0])}
            className="text-sm file:mr-3 file:rounded-xl file:border file:border-border file:bg-muted file:px-3 file:py-2 file:text-sm file:text-foreground"
          />
          {fileNote !== undefined && (
            <p
              id="arquivo-do-documento-erro"
              role="alert"
              className="m-0 px-1 text-sm text-destructive"
            >
              {fileNote}
            </p>
          )}
        </div>
        <div>
          <Button type="submit" disabled={busy}>
            {busy ? 'Aguarde…' : 'Adicionar'}
          </Button>
        </div>
      </form>

      <section className="grid gap-3" aria-label="Documentos">
        <h2 className="m-0 text-xl font-semibold">Documentos da empresa</h2>
        {items.length === 0 ? (
          <p className="m-0 text-sm text-muted-foreground">
            Nenhum documento ainda. Adicione o primeiro acima.
          </p>
        ) : (
          <ul className="m-0 grid list-none gap-3 p-0">
            {items.map((item) => (
              <li
                key={item.id}
                className="grid gap-2 rounded-2xl border border-border bg-card p-4 text-card-foreground"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <strong className="[overflow-wrap:anywhere]">{item.title}</strong>
                    {item.isSample && <Chip>Exemplo</Chip>}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setPending(item)}
                    aria-label={`Apagar o documento ${item.title}`}
                  >
                    Apagar
                  </Button>
                </div>
                <p className="m-0 text-xs text-muted-foreground">
                  {item.charCount.toLocaleString('pt-BR')} caracteres ·{' '}
                  {item.chunkCount.toLocaleString('pt-BR')}{' '}
                  {item.chunkCount === 1 ? 'trecho' : 'trechos'}
                </p>
                <p className="m-0 text-sm text-muted-foreground [overflow-wrap:anywhere]">
                  {item.preview}
                </p>
              </li>
            ))}
          </ul>
        )}
        {next !== null && (
          <div>
            <Button variant="outline" disabled={busy} onClick={() => void loadMore()}>
              Carregar mais
            </Button>
          </div>
        )}
      </section>

      <ConfirmDialog
        request={
          pending === null
            ? null
            : {
                title: 'Apagar o documento?',
                text: `"${pending.title}" e seus trechos deixam de ser usados pela IA. Não dá para desfazer.`,
                confirmLabel: 'Apagar',
              }
        }
        busy={busy}
        onConfirm={() => {
          if (pending !== null) void remove(pending);
        }}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
