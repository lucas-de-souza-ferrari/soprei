import { Bell } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { areaPath } from './company-nav';
import { isPlainClick } from './ConversationsPage';
import { notificationsApi } from './notifications-api';
import { badgeText, bellLabel, shouldAnnounce, SummaryPoller } from './notification-rules';

export interface NotificationBellProps {
  readonly companyId: string;
  readonly onOpen: () => void;
  /** Muda quando algo pode ter alterado a contagem (ex.: resolveu uma notificação): relê na hora. */
  readonly refreshKey?: number;
}

const ANNOUNCE_MS = 6_000;

/**
 * Sino do cabeçalho (spec 038): lê só o número de abertas (`.../notifications/summary`) ao montar, a cada
 * 30 s com a aba visível e ao voltar para a aba. Remontado a cada empresa (`key`), e o `stop()` descarta
 * resposta tardia. Quando a contagem sobe, um aviso discreto (`aria-live="polite"`); sem som. Nada vai
 * para `localStorage`, título da aba nem URL.
 */
export function NotificationBell({ companyId, onOpen, refreshKey = 0 }: NotificationBellProps) {
  const [open, setOpen] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const previous = useRef<number | null>(null);
  const poller = useRef<SummaryPoller | null>(null);

  useEffect(() => {
    let clearAnnouncement: ReturnType<typeof setTimeout> | undefined;
    const instance = new SummaryPoller({
      read: async () => (await notificationsApi.summary(companyId)).open,
      onCount: (count) => {
        if (shouldAnnounce(previous.current, count)) {
          setAnnouncement('Novo pedido de atendimento humano');
          clearTimeout(clearAnnouncement);
          clearAnnouncement = setTimeout(() => setAnnouncement(''), ANNOUNCE_MS);
        }
        previous.current = count;
        setOpen(count);
      },
      isVisible: () => document.visibilityState === 'visible',
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
    poller.current = instance;
    const onVisibility = () => instance.visibilityChanged();
    document.addEventListener('visibilitychange', onVisibility);
    instance.start();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      instance.stop();
      clearTimeout(clearAnnouncement);
      poller.current = null;
    };
  }, [companyId]);

  useEffect(() => {
    if (refreshKey > 0) poller.current?.refresh();
  }, [refreshKey]);

  const badge = badgeText(open);
  return (
    <>
      <a
        href={areaPath('notificacoes')}
        aria-label={bellLabel(open)}
        title="Notificações"
        onClick={(event) => {
          if (!isPlainClick(event)) return;
          event.preventDefault();
          onOpen();
        }}
        className="relative inline-flex size-10 items-center justify-center rounded-md text-foreground hover:bg-muted focus-visible:outline-3 focus-visible:outline-ring"
      >
        <Bell aria-hidden="true" className="size-5" />
        {badge !== '' && (
          <span
            aria-hidden="true"
            data-testid="notification-badge"
            className="absolute -top-0.5 -right-0.5 min-w-5 rounded-full bg-primary px-1 text-center text-[11px] leading-5 font-semibold text-primary-foreground"
          >
            {badge}
          </span>
        )}
      </a>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </>
  );
}
