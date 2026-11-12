import { UserRound } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../components/motion/button';
import { Loader } from '../components/motion/loader';
import { conversasPath } from './company-nav';
import { formatActivity } from './conversation-format';
import { isPlainClick } from './ConversationsPage';
import { type NotificationItem, notificationsApi, reasonLabel } from './notifications-api';
import { RetryAlert } from './RetryAlert';

export interface NotificationsPageProps {
  readonly companyId: string;
  /** `notification:resolve`: sem ela, a tela só lista (VIEWER). */
  readonly canResolve: boolean;
  readonly settle: (error: unknown) => string | null;
  readonly onOpenConversation: (conversationId: string) => void;
  /** Avisa o sino de que a contagem mudou. */
  readonly onChanged: () => void;
}

type Tab = 'open' | 'resolved';
type Status = 'loading' | 'ready' | 'failed';

const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: 'open', label: 'Abertas' },
  { id: 'resolved', label: 'Resolvidas' },
];

/**
 * Notificações da empresa (spec 038): hoje, os pedidos de atendimento humano feitos pela IA. Abas
 * "Abertas" e "Resolvidas", 30 por página com "Carregar mais", "Abrir conversa" e "Marcar como resolvido".
 * O contato aparece só com o rótulo mascarado do servidor; o motivo é texto fixo do site. Resposta tardia
 * (troca de aba ou de empresa) é descartada pelo contador de geração.
 */
export function NotificationsPage({
  companyId,
  canResolve,
  settle,
  onOpenConversation,
  onChanged,
}: NotificationsPageProps) {
  const [tab, setTab] = useState<Tab>('open');
  const [items, setItems] = useState<readonly NotificationItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [busy, setBusy] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const generation = useRef(0);

  const load = useCallback(
    async (which: Tab, cursor?: string): Promise<void> => {
      const stamp = ++generation.current;
      setBusy(true);
      setError(null);
      try {
        const page = await notificationsApi.list(companyId, { status: which, cursor });
        if (stamp !== generation.current) return;
        setItems((current) => (cursor === undefined ? page.items : [...current, ...page.items]));
        setNextCursor(page.nextCursor);
        setStatus('ready');
      } catch (cause) {
        if (stamp !== generation.current) return;
        setStatus((current) => (current === 'ready' ? 'ready' : 'failed'));
        setError(settle(cause));
      } finally {
        if (stamp === generation.current) setBusy(false);
      }
    },
    [companyId, settle],
  );

  useEffect(() => {
    setItems([]);
    setNextCursor(null);
    setStatus('loading');
    void load(tab);
    return () => {
      generation.current++;
    };
  }, [load, tab]);

  const resolve = async (item: NotificationItem): Promise<void> => {
    setResolving(item.id);
    setError(null);
    try {
      await notificationsApi.resolve(companyId, item.id);
      setItems((current) => current.filter((other) => other.id !== item.id));
      setAnnouncement('Notificação marcada como resolvida');
      onChanged();
    } catch (cause) {
      setError(settle(cause));
    } finally {
      setResolving(null);
    }
  };

  const now = new Date();
  return (
    <div className="grid gap-4">
      <div role="tablist" aria-label="Notificações" className="flex gap-2">
        {TABS.map((item) => (
          <Button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            variant={tab === item.id ? 'primary' : 'outline'}
            size="sm"
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </Button>
        ))}
      </div>

      {error !== null && status === 'failed' && (
        <RetryAlert text={error} disabled={busy} onRetry={() => void load(tab)} />
      )}
      {error !== null && status === 'ready' && (
        <p role="alert" className="m-0 text-sm text-destructive">
          {error}
        </p>
      )}

      {status === 'loading' && (
        <div className="grid place-items-center gap-3 py-8 text-sm text-muted-foreground">
          <Loader variant="spinner" size={24} label="Carregando notificações" />
          <span aria-hidden="true">Carregando notificações…</span>
        </div>
      )}

      {status === 'ready' && items.length === 0 && (
        <p className="m-0 py-2 text-muted-foreground">
          {tab === 'open'
            ? 'Nenhum pedido de atendimento humano aberto.'
            : 'Nenhuma notificação resolvida ainda.'}
        </p>
      )}

      {items.length > 0 && (
        <ul className="m-0 grid list-none gap-3 p-0" aria-label="Notificações, da mais recente">
          {items.map((item) => (
            <li
              key={item.id}
              data-testid="notification-item"
              className="grid gap-2 rounded-lg border border-border bg-card p-4 text-card-foreground"
            >
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                <strong className="flex items-center gap-2">
                  <UserRound aria-hidden="true" className="size-4" />
                  Atendimento humano solicitado
                </strong>
                <time dateTime={item.createdAt} className="text-sm text-muted-foreground">
                  {formatActivity(item.createdAt, now)}
                </time>
              </div>
              <p className="m-0 text-sm">
                {item.conversation?.contactLabel ?? 'Conversa indisponível'}
                {' · '}
                {reasonLabel(item.reason)}
              </p>
              {item.status === 'RESOLVED' && (
                <p className="m-0 text-sm text-muted-foreground">
                  {item.resolvedByMe ? 'Resolvida por você' : 'Resolvida pela equipe'}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {item.conversation !== null && (
                  <a
                    href={conversasPath({ kind: 'detail', id: item.conversation.id })}
                    onClick={(event) => {
                      if (!isPlainClick(event) || item.conversation === null) return;
                      event.preventDefault();
                      onOpenConversation(item.conversation.id);
                    }}
                    className="inline-flex min-h-9 items-center rounded-md px-3 text-sm text-primary underline focus-visible:outline-3 focus-visible:outline-ring"
                  >
                    Abrir conversa
                  </a>
                )}
                {canResolve && item.status === 'OPEN' && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={resolving !== null}
                    onClick={() => void resolve(item)}
                  >
                    {resolving === item.id ? 'Marcando…' : 'Marcar como resolvido'}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {nextCursor !== null && status === 'ready' && (
        <div>
          <Button variant="secondary" disabled={busy} onClick={() => void load(tab, nextCursor)}>
            {busy ? 'Carregando…' : 'Carregar mais'}
          </Button>
        </div>
      )}

      <p role="status" aria-live="polite" className="m-0 text-xs text-muted-foreground">
        {announcement}
      </p>
    </div>
  );
}
