import { MessageBubble, MessageBubbleContent } from '../components/motion/message-bubble';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '../components/motion/button';
import { Loader } from '../components/motion/loader';
import { ApiError } from '../api';
import {
  type ConversationItem,
  companyApi,
  isStillSelected,
  MESSAGES_PAGE_SIZE,
  type MessageItem,
} from './company-api';
import { conversasPath } from './company-nav';
import {
  chronological,
  formatActivity,
  formatTime,
  type HistoryEntry,
  sendIndicator,
  withDaySeparators,
} from './conversation-format';
import { isPlainClick } from './ConversationsPage';
import { RetryAlert } from './RetryAlert';

export interface ConversationPageProps {
  readonly companyId: string;
  /** `null` = o id da URL não é um UUID: "não encontrada" sem chamar a API. */
  readonly conversationId: string | null;
  /** Falha com mensagem de tela (texto) ou tratada por quem chama (login, empresa trocada: `null`). */
  readonly settle: (error: unknown) => string | null;
  /** 404 com a empresa selecionada mudada: segue o fluxo "A empresa selecionada mudou". */
  readonly onChanged: () => void;
  readonly onBack: () => void;
  /** Relógio injetável (os testes de navegador usam o relógio falso do Playwright). */
  readonly now?: () => Date;
}

type Status = 'loading' | 'ready' | 'failed' | 'notfound';
type Busy = 'none' | 'refresh' | 'older';

const NOT_FOUND_TEXT = 'Conversa não encontrada.';
const EMPTY_TEXT = 'Esta conversa ainda não tem mensagens.';
const TICK_MS = 15_000;

/**
 * Histórico de uma conversa (spec 024), só leitura: abre nas 50 mensagens mais recentes (buscadas com
 * `order=desc` e invertidas aqui), na ordem do chat, com "Carregar mensagens anteriores" no topo. O
 * texto das mensagens só vive no estado desta tela e é desenhado como texto puro (nunca HTML nem
 * Markdown); não vai a URL, storage, título da página nem console.
 */
export function ConversationPage({
  companyId,
  conversationId,
  settle,
  onChanged,
  onBack,
  now = () => new Date(),
}: ConversationPageProps) {
  const [conversation, setConversation] = useState<ConversationItem | null>(null);
  const [messages, setMessages] = useState<readonly MessageItem[]>([]);
  const [older, setOlder] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>(conversationId === null ? 'notfound' : 'loading');
  const [busy, setBusy] = useState<Busy>('none');
  const [error, setError] = useState<{ text: string; retry: 'first' | 'older' } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [, setTick] = useState(0);
  const generation = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  /** O que fazer com a rolagem depois do próximo desenho: ir ao fim, ou manter a posição de leitura. */
  const pendingScroll = useRef<
    { kind: 'end' } | { kind: 'keep'; height: number; top: number; focusId: string | null } | null
  >(null);
  const itemRefs = useRef(new Map<string, HTMLLIElement>());

  useEffect(() => {
    const stamp = generation;
    return () => {
      stamp.current++;
    };
  }, [companyId, conversationId]);

  /** 404: o id é de outra empresa, não existe ou a empresa selecionada mudou. Nunca diz qual. */
  const notFound = useCallback(
    async (stamp: number): Promise<void> => {
      try {
        const same = await isStillSelected(companyId);
        if (stamp !== generation.current) return;
        if (same) setStatus('notfound');
        else onChanged();
      } catch (cause) {
        if (stamp !== generation.current) return;
        setStatus('failed');
        const text = settle(cause);
        if (text !== null) setError({ text, retry: 'first' });
      }
    },
    [companyId, onChanged, settle],
  );

  const handle = useCallback(
    async (cause: unknown, stamp: number, retry: 'first' | 'older'): Promise<void> => {
      if (stamp !== generation.current) return;
      if (cause instanceof ApiError && cause.status === 404) {
        await notFound(stamp);
        return;
      }
      const text = settle(cause);
      if (text !== null) setError({ text, retry });
    },
    [notFound, settle],
  );

  /** Abre (ou atualiza) nas mensagens mais recentes. */
  const loadNewest = useCallback(async (): Promise<void> => {
    if (conversationId === null) return;
    const stamp = ++generation.current;
    setBusy('refresh');
    setError(null);
    try {
      const page = await companyApi.conversationMessages(companyId, conversationId, {
        limit: MESSAGES_PAGE_SIZE,
        order: 'desc',
      });
      if (stamp !== generation.current) return;
      pendingScroll.current = { kind: 'end' };
      setConversation(page.conversation);
      setMessages(chronological(page.items));
      setOlder(page.nextCursor);
      setStatus('ready');
      setAnnouncement('');
    } catch (cause) {
      if (stamp !== generation.current) return;
      setStatus((current) => (current === 'ready' ? 'ready' : 'failed'));
      await handle(cause, stamp, 'first');
    } finally {
      if (stamp === generation.current) setBusy('none');
    }
  }, [companyId, conversationId, handle]);

  useEffect(() => {
    setConversation(null);
    setMessages([]);
    setOlder(null);
    setError(null);
    setAnnouncement('');
    if (conversationId === null) {
      setStatus('notfound');
      return;
    }
    setStatus('loading');
    void loadNewest();
  }, [conversationId, loadNewest]);

  const loadOlder = async (): Promise<void> => {
    if (conversationId === null || older === null || busy !== 'none') return;
    const stamp = ++generation.current;
    const box = scroller.current;
    setBusy('older');
    setError(null);
    setAnnouncement('Carregando mensagens anteriores…');
    try {
      const page = await companyApi.conversationMessages(companyId, conversationId, {
        limit: MESSAGES_PAGE_SIZE,
        order: 'desc',
        cursor: older,
      });
      if (stamp !== generation.current) return;
      const known = new Set(messages.map((message) => message.id));
      const fresh = chronological(page.items).filter((message) => !known.has(message.id));
      pendingScroll.current = {
        kind: 'keep',
        height: box?.scrollHeight ?? 0,
        top: box?.scrollTop ?? 0,
        // O foco volta à mensagem que era a primeira: continua no mesmo lugar da leitura.
        focusId: messages[0]?.id ?? null,
      };
      setMessages([...fresh, ...messages]);
      setOlder(page.nextCursor);
      setAnnouncement(
        fresh.length === 1
          ? '1 mensagem anterior carregada'
          : `${String(fresh.length)} mensagens anteriores carregadas`,
      );
    } catch (cause) {
      if (stamp !== generation.current) return;
      setAnnouncement('');
      await handle(cause, stamp, 'older');
    } finally {
      if (stamp === generation.current) setBusy('none');
    }
  };

  // Rolagem depois do desenho: abrir/atualizar vai à última mensagem; carregar anteriores não rola
  // (compensa a altura acrescentada) e devolve o foco à mensagem em que a leitura estava.
  useLayoutEffect(() => {
    const action = pendingScroll.current;
    const box = scroller.current;
    if (action === null || box === null) return;
    pendingScroll.current = null;
    if (action.kind === 'end') {
      box.scrollTop = box.scrollHeight;
      return;
    }
    box.scrollTop = action.top + (box.scrollHeight - action.height);
    if (action.focusId !== null)
      itemRefs.current.get(action.focusId)?.focus({ preventScroll: true });
  }, [messages]);

  // "Enviando…" vira "Não enviada" com o tempo, sem recarregar: relê o relógio de vez em quando.
  const current = now();
  const waiting =
    conversation !== null &&
    messages.some((message) => sendIndicator(message, conversation.channel, current) === 'sending');
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setTick((value) => value + 1), TICK_MS);
    return () => clearInterval(timer);
  }, [waiting]);

  const entries: HistoryEntry[] = withDaySeparators(messages, current);

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <a
          href={conversasPath({ kind: 'list' })}
          onClick={(event) => {
            if (!isPlainClick(event)) return;
            event.preventDefault();
            onBack();
          }}
          className="w-fit text-sm text-primary underline focus-visible:outline-3 focus-visible:outline-ring"
        >
          Voltar às conversas
        </a>
        {status !== 'notfound' && (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="m-0 text-xl font-semibold [overflow-wrap:anywhere]">
                {conversation?.contactLabel ?? 'Conversa'}
              </h2>
              {conversation?.channel === 'simulator' && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">
                  Teste
                </span>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== 'none' || status === 'loading'}
              onClick={() => void loadNewest()}
            >
              Atualizar
            </Button>
          </div>
        )}
        {conversation !== null && status === 'ready' && (
          <p className="m-0 text-sm text-muted-foreground">
            Última atividade:{' '}
            <time dateTime={conversation.updatedAt}>
              {formatActivity(conversation.updatedAt, current)}
            </time>
          </p>
        )}
      </div>

      {error?.retry === 'first' && (
        <RetryAlert
          text={error.text}
          disabled={busy !== 'none'}
          onRetry={() => void loadNewest()}
        />
      )}

      {status === 'notfound' && (
        <div className="grid gap-2 py-2">
          <p className="m-0 font-medium">{NOT_FOUND_TEXT}</p>
          <p className="m-0 text-sm text-muted-foreground">
            Ela pode ter sido removida ou não pertencer a esta empresa.
          </p>
        </div>
      )}

      {status === 'loading' && (
        <div className="grid place-items-center gap-3 py-8 text-sm text-muted-foreground">
          <Loader variant="spinner" size={24} label="Carregando a conversa" />
          <span aria-hidden="true">Carregando a conversa…</span>
        </div>
      )}

      {status === 'ready' && (
        <div
          ref={scroller}
          role="region"
          aria-label="Mensagens da conversa"
          // Região rolável precisa ser alcançável pelo teclado.
          tabIndex={0}
          className="max-h-[65vh] overflow-x-hidden overflow-y-auto rounded-md border border-border p-3 focus-visible:outline-3 focus-visible:outline-ring"
        >
          {older !== null && (
            <div className="pb-3">
              <Button
                variant="secondary"
                size="sm"
                disabled={busy !== 'none'}
                onClick={() => void loadOlder()}
              >
                {busy === 'older' ? 'Carregando…' : 'Carregar mensagens anteriores'}
              </Button>
            </div>
          )}
          {error?.retry === 'older' && (
            <RetryAlert
              text={error.text}
              disabled={busy !== 'none'}
              onRetry={() => void loadOlder()}
            />
          )}
          {messages.length === 0 ? (
            <p className="m-0 py-2 text-muted-foreground">{EMPTY_TEXT}</p>
          ) : (
            <ol className="m-0 grid list-none gap-3 p-0" aria-label="Mensagens, da mais antiga">
              {entries.map((entry) =>
                entry.kind === 'day' ? (
                  <li
                    key={`dia-${entry.key}`}
                    role="separator"
                    className="py-1 text-center text-xs text-muted-foreground"
                  >
                    {entry.label}
                  </li>
                ) : (
                  <li
                    key={entry.message.id}
                    tabIndex={-1}
                    ref={(node) => {
                      if (node === null) itemRefs.current.delete(entry.message.id);
                      else itemRefs.current.set(entry.message.id, node);
                    }}
                    className="flex outline-none data-[mine=true]:justify-end"
                    data-mine={entry.message.role === 'ASSISTANT'}
                  >
                    <Bubble
                      message={entry.message}
                      channel={conversation?.channel ?? 'simulator'}
                      now={current}
                    />
                  </li>
                ),
              )}
            </ol>
          )}
        </div>
      )}

      <p role="status" aria-live="polite" className="m-0 text-xs text-muted-foreground">
        {announcement}
      </p>
    </div>
  );
}

function Bubble({
  message,
  channel,
  now,
}: {
  readonly message: MessageItem;
  readonly channel: ConversationItem['channel'];
  readonly now: Date;
}) {
  const fromContact = message.role === 'USER';
  const indicator = sendIndicator(message, channel, now);
  return (
    // Bolha do beUI (spec 029): contato à esquerda, assistente (o nosso lado) à direita.
    <MessageBubble align={fromContact ? 'start' : 'end'} variant={fromContact ? 'soft' : 'tint'}>
      <MessageBubbleContent className="min-w-0">
        <p className="m-0 text-xs font-semibold">{fromContact ? 'Contato' : 'Assistente'}</p>
        <p dir="auto" className="m-0 [overflow-wrap:anywhere] whitespace-pre-wrap">
          {message.content}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
          {message.isFallback && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-foreground">
              Resposta padrão: houve falha ao gerar a resposta
            </span>
          )}
          {indicator === 'sending' && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
              Enviando…
            </span>
          )}
          {indicator === 'not-sent' && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-destructive">
              Não enviada ao WhatsApp. Confira o estado do canal em Canal.
            </span>
          )}
        </div>
      </MessageBubbleContent>
    </MessageBubble>
  );
}
