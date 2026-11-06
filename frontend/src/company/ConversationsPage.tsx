import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { Button } from '../components/motion/button';
import { Loader } from '../components/motion/loader';
import { type ConversationItem, companyApi, CONVERSATIONS_PAGE_SIZE } from './company-api';
import { areaPath, canOpen, conversasPath, type AreaPage } from './company-nav';
import { ConfigurationCard } from './ConfigurationCard';
import { formatActivity } from './conversation-format';
import type { WizardStepId } from './onboarding-steps';
import { RetryAlert } from './RetryAlert';

export interface ConversationsPageProps {
  readonly companyId: string;
  /** Permissões do papel: só decidem para quais abas a orientação do estado vazio oferece link. */
  readonly permissions: readonly string[];
  /** Falha com mensagem de tela (texto) ou tratada por quem chama (login, empresa trocada: `null`). */
  readonly settle: (error: unknown) => string | null;
  readonly onOpen: (conversationId: string) => void;
  readonly onNavigate: (page: AreaPage) => void;
  /** Abre um passo do assistente de primeiros passos (spec 030); o cartão "Configuração" usa. */
  readonly onOpenStep: (step: WizardStepId) => void;
}

type Status = 'loading' | 'ready' | 'failed';
type Busy = 'none' | 'refresh' | 'more';

/** Clique "normal" (esquerdo, sem modificador): navega sem recarregar; os demais abrem o link do navegador. */
export function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * Lista de conversas da empresa (spec 024), só leitura: mais recentes primeiro (última atividade),
 * 30 por página, sem prévia nem contagem. O rótulo do contato vem mascarado do servidor; esta tela
 * nunca vê o telefone. Resposta que chega depois de trocar de empresa (ou de tocar em "Atualizar")
 * é descartada pelo contador de geração. Nada daqui vai para `localStorage`, URL de erro ou console.
 */
export function ConversationsPage({
  companyId,
  permissions,
  settle,
  onOpen,
  onNavigate,
  onOpenStep,
}: ConversationsPageProps) {
  const [items, setItems] = useState<readonly ConversationItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [busy, setBusy] = useState<Busy>('none');
  const [error, setError] = useState<{ text: string; retry: 'first' | 'more' } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const generation = useRef(0);
  const focusFrom = useRef<number | null>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const stamp = generation;
    return () => {
      stamp.current++;
    };
  }, [companyId]);

  const fail = useCallback(
    (cause: unknown, stamp: number, retry: 'first' | 'more'): void => {
      if (stamp !== generation.current) return;
      const text = settle(cause);
      if (text !== null) setError({ text, retry });
    },
    [settle],
  );

  /** Relê a primeira página e descarta o que estava carregado. */
  const loadFirst = useCallback(async (): Promise<void> => {
    const stamp = ++generation.current;
    setBusy('refresh');
    setError(null);
    try {
      const page = await companyApi.conversations(companyId, { limit: CONVERSATIONS_PAGE_SIZE });
      if (stamp !== generation.current) return;
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setStatus('ready');
      setAnnouncement(countText(page.items.length));
    } catch (cause) {
      if (stamp !== generation.current) return;
      // Com itens já na tela eles ficam; sem eles, a tela vira o estado de erro.
      setStatus((current) => (current === 'ready' ? 'ready' : 'failed'));
      fail(cause, stamp, 'first');
    } finally {
      if (stamp === generation.current) setBusy('none');
    }
  }, [companyId, fail]);

  useEffect(() => {
    setItems([]);
    setNextCursor(null);
    setStatus('loading');
    setAnnouncement('');
    void loadFirst();
  }, [loadFirst]);

  const loadMore = async (): Promise<void> => {
    if (nextCursor === null || busy !== 'none') return;
    const stamp = ++generation.current;
    setBusy('more');
    setError(null);
    setAnnouncement('Carregando mais conversas…');
    try {
      const page = await companyApi.conversations(companyId, {
        limit: CONVERSATIONS_PAGE_SIZE,
        cursor: nextCursor,
      });
      if (stamp !== generation.current) return;
      focusFrom.current = items.length;
      const known = new Set(items.map((item) => item.id));
      const merged = [...items, ...page.items.filter((item) => !known.has(item.id))];
      setItems(merged);
      setNextCursor(page.nextCursor);
      setAnnouncement(countText(merged.length));
    } catch (cause) {
      if (stamp !== generation.current) return;
      setAnnouncement('');
      fail(cause, stamp, 'more');
    } finally {
      if (stamp === generation.current) setBusy('none');
    }
  };

  // Depois de anexar a página, o foco vai para a primeira conversa nova (o botão pode ter sumido).
  useEffect(() => {
    const index = focusFrom.current;
    if (index === null) return;
    focusFrom.current = null;
    list.current?.querySelectorAll('a').item(index)?.focus();
  }, [items]);

  const now = new Date();
  const guide = (['canal', 'testar'] as const).filter((page) => canOpen(page, permissions));

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="m-0 text-xl font-semibold">Conversas</h2>
        <Button
          variant="outline"
          size="sm"
          disabled={busy !== 'none' || status === 'loading'}
          onClick={() => void loadFirst()}
        >
          Atualizar
        </Button>
      </div>

      <ConfigurationCard
        companyId={companyId}
        permissions={permissions}
        settle={settle}
        onOpenStep={onOpenStep}
      />

      {error?.retry === 'first' && (
        <RetryAlert text={error.text} disabled={busy !== 'none'} onRetry={() => void loadFirst()} />
      )}

      {status === 'loading' && (
        <div className="grid place-items-center gap-3 py-8 text-sm text-muted-foreground">
          <Loader variant="spinner" size={24} label="Carregando conversas" />
          <span aria-hidden="true">Carregando conversas…</span>
        </div>
      )}

      {status === 'ready' && items.length === 0 && (
        <p className="m-0 py-2 text-muted-foreground">
          {'Ainda não há conversas.'}
          {guide.includes('canal') && (
            <>
              {' Conecte o número em '}
              <AreaLink page="canal" label="Canal" onNavigate={onNavigate} />
              {guide.includes('testar') ? ' ou use ' : '.'}
            </>
          )}
          {guide.includes('testar') && (
            <>
              {guide.includes('canal') ? '' : ' Use '}
              <AreaLink page="testar" label="Testar" onNavigate={onNavigate} />
              {' para criar uma conversa de teste.'}
            </>
          )}
        </p>
      )}

      {items.length > 0 && (
        <ul ref={list} className="m-0 list-none p-0" aria-label="Conversas, da mais recente">
          {items.map((item) => (
            <li key={item.id} className="border-b border-border last:border-b-0">
              <a
                href={conversasPath({ kind: 'detail', id: item.id })}
                onClick={(event) => {
                  if (!isPlainClick(event)) return;
                  event.preventDefault();
                  onOpen(item.id);
                }}
                className="flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-md px-2 py-3 text-foreground no-underline hover:bg-muted focus-visible:outline-3 focus-visible:outline-ring"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <strong className="[overflow-wrap:anywhere]">{item.contactLabel}</strong>
                  {item.channel === 'simulator' && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">
                      Teste
                    </span>
                  )}
                </span>
                <time dateTime={item.updatedAt} className="text-sm text-muted-foreground">
                  {formatActivity(item.updatedAt, now)}
                </time>
              </a>
            </li>
          ))}
        </ul>
      )}

      {nextCursor !== null && status === 'ready' && (
        <div>
          <Button variant="secondary" disabled={busy !== 'none'} onClick={() => void loadMore()}>
            {busy === 'more' ? 'Carregando…' : 'Carregar mais'}
          </Button>
        </div>
      )}

      {error?.retry === 'more' && (
        <RetryAlert text={error.text} disabled={busy !== 'none'} onRetry={() => void loadMore()} />
      )}

      <p role="status" aria-live="polite" className="m-0 text-xs text-muted-foreground">
        {announcement}
      </p>
    </div>
  );
}

function countText(total: number): string {
  return total === 1 ? '1 conversa carregada' : `${String(total)} conversas carregadas`;
}

function AreaLink({
  page,
  label,
  onNavigate,
}: {
  readonly page: AreaPage;
  readonly label: string;
  readonly onNavigate: (page: AreaPage) => void;
}) {
  return (
    <a
      href={areaPath(page)}
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        onNavigate(page);
      }}
      className="text-primary underline focus-visible:outline-3 focus-visible:outline-ring"
    >
      {label}
    </a>
  );
}
