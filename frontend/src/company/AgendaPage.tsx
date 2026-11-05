import {
  Ban,
  CheckCheck,
  CheckCircle2,
  Clock,
  UserX,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import { Alert, AlertContent, AlertDescription, AlertIcon } from '../components/motion/alert';
import { Button } from '../components/motion/button';
import { Loader } from '../components/motion/loader';
import {
  AGENDA_STALE_MESSAGE,
  type AgendaResource,
  type AgendaService,
  agendaApi,
  agendaMessageOf,
  type Appointment,
  type AppointmentStatus,
  APPOINTMENT_STATUSES,
  isSlotTaken,
  SLOT_TAKEN_MESSAGE,
} from './agenda-api';
import {
  addDays,
  dayHeading,
  groupByDay,
  hasStarted,
  type ItemAction,
  STATUS_LABELS,
  weekAnnouncement,
  weekDates,
  weekLabel,
  weekStart,
} from './agenda-rules';
import {
  BlockDialog,
  Field,
  FIELD_CLASS,
  ItemDialog,
  NewAppointmentDialog,
  PrivacyNote,
  Problem,
} from './AgendaDialogs';
import { AgendaCalendar } from './AgendaCalendar';
import {
  addMonths,
  type AgendaView,
  monthAnnouncement,
  monthLabel,
  monthRange,
  monthStart,
  RANGE_TOO_LARGE_MONTH_MESSAGE,
} from './calendar-rules';
import { ConfirmDialog } from './ConfirmDialog';
import { Modal } from './Modal';
import type { PageProps } from './PersonaPage';

type Notice = { tone: 'error' | 'success'; text: string } | null;
type Dialog =
  | { kind: 'new'; initialStart?: string }
  | { kind: 'item'; item: Appointment }
  | { kind: 'block' }
  | null;

export const AGENDA_SAVE_FAILED = 'Não foi possível salvar agora. Tente de novo.';
const OWN_MESSAGE_STATUSES = [403, 429, 502, 503];

/** Ícone do estado: o estado sempre tem texto e ícone, nunca só cor. */
const STATUS_ICONS: Readonly<Record<AppointmentStatus, LucideIcon>> = {
  PENDING: Clock,
  CONFIRMED: CheckCircle2,
  CANCELLED: XCircle,
  COMPLETED: CheckCheck,
  NO_SHOW: UserX,
};
const STATUS_COLORS: Readonly<Record<AppointmentStatus, string>> = {
  PENDING: 'text-primary',
  CONFIRMED: 'text-(--color-success)',
  CANCELLED: 'text-muted-foreground',
  COMPLETED: 'text-foreground',
  NO_SHOW: 'text-destructive',
};

function StatusBadge({ item }: { item: Appointment }) {
  const block = item.kind === 'BLOCK' && item.status !== 'CANCELLED';
  const Icon = block ? Ban : STATUS_ICONS[item.status];
  const color = block ? 'text-muted-foreground' : STATUS_COLORS[item.status];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium ${color}`}
    >
      <Icon aria-hidden="true" className="size-4" />
      {block ? 'Bloqueado' : STATUS_LABELS[item.status]}
    </span>
  );
}

const who = (item: Appointment): string | null => item.customerLabel ?? item.contactLabel;

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-primary">
      {children}
    </span>
  );
}

const NARROW_QUERY = '(max-width: 767px)';

/** Tela estreita (abaixo de 768 px), acompanhando mudanças de tamanho. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(NARROW_QUERY);
    const onChange = () => setNarrow(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

const VIEW_LABELS: Readonly<Record<AgendaView, string>> = {
  list: 'Lista',
  week: 'Semana',
  month: 'Mês',
};

export interface AgendaPageProps extends PageProps {
  readonly permissions: readonly string[];
  readonly onConfigure: () => void;
}

/**
 * Agenda da empresa (spec 027): a semana em **lista agrupada por dia** (acessível por construção). As
 * datas e horas vêm prontas do servidor, no fuso da empresa; o navegador não converte fuso. Nome do
 * nome de quem é atendido, serviço e horários só vivem no estado desta tela (nada em URL, armazenamento do navegador,
 * título da página nem log); resposta que chega depois de trocar de empresa ou de semana é descartada.
 */
export function AgendaPage({ companyId, settle, permissions, onConfigure }: AgendaPageProps) {
  const canManage = permissions.includes('schedule:manage');
  const canConfigure = permissions.includes('schedule:configure');
  const [timezone, setTimezone] = useState('');
  const [today, setToday] = useState('');
  // Qualquer dia do período mostrado: a semana (lista e semana) e o mês saem dele.
  const [cursor, setCursor] = useState<string | null>(null);
  const narrow = useNarrow();
  // Visão só em memória (nada em armazenamento, URL ou título): Lista no celular e Semana no computador.
  const [view, setView] = useState<AgendaView>(() => (narrow ? 'list' : 'week'));
  const [tooLarge, setTooLarge] = useState(false);
  const [focusDay, setFocusDay] = useState<string | null>(null);
  const [resources, setResources] = useState<readonly AgendaResource[]>([]);
  const [services, setServices] = useState<readonly AgendaService[]>([]);
  const [items, setItems] = useState<readonly Appointment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [serviceFilter, setServiceFilter] = useState('');
  const [resourceFilter, setResourceFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<AppointmentStatus | ''>('');
  const [announcement, setAnnouncement] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [dialogProblem, setDialogProblem] = useState<string | null>(null);
  const [slotsVersion, setSlotsVersion] = useState(0);
  const [confirm, setConfirm] = useState<Appointment | null>(null);
  const generation = useRef(0);

  // 1) Configurações (fuso e "hoje" da empresa), recursos e serviços, uma vez por empresa.
  useEffect(() => {
    const stamp = ++generation.current;
    setLoadError(null);
    Promise.all([
      agendaApi.settings(companyId),
      agendaApi.resources(companyId),
      agendaApi.services(companyId),
    ])
      .then(([settings, resourceList, serviceList]) => {
        if (stamp !== generation.current) return;
        setTimezone(settings.timezone);
        setToday(settings.today);
        setCursor((current) => current ?? settings.today);
        setResources(resourceList);
        setServices(serviceList);
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

  const start = cursor === null ? null : weekStart(cursor);
  const month = cursor === null ? null : monthStart(cursor);
  const range =
    start === null || month === null
      ? null
      : view === 'month'
        ? monthRange(month)
        : { from: start, to: addDays(start, 6) };
  const rangeFrom = range?.from ?? null;
  const rangeTo = range?.to ?? null;

  // 2) Os itens do período (semana ou mês) e dos filtros.
  useEffect(() => {
    if (rangeFrom === null || rangeTo === null) return;
    const stamp = ++generation.current;
    setLoadError(null);
    setTooLarge(false);
    agendaApi
      .appointments(companyId, {
        from: rangeFrom,
        to: rangeTo,
        resourceId: resourceFilter === '' ? undefined : resourceFilter,
        serviceId: serviceFilter === '' ? undefined : serviceFilter,
        status: statusFilter === '' ? undefined : statusFilter,
      })
      .then((result) => {
        if (stamp !== generation.current) return;
        setItems(result.items);
        setToday(result.today);
        setLoaded(true);
        setAnnouncement(
          view === 'month' && month !== null
            ? monthAnnouncement(month, result.items.length)
            : weekAnnouncement(weekStart(rangeFrom), result.items.length),
        );
      })
      .catch((error: unknown) => {
        if (stamp !== generation.current) return;
        // Mês com itens demais: mensagem constante e a saída pela Semana; nada é truncado em silêncio.
        if (view === 'month' && error instanceof ApiError && error.code === 'RANGE_TOO_LARGE') {
          setItems([]);
          setLoaded(true);
          setTooLarge(true);
          setAnnouncement('');
          return;
        }
        const own = agendaMessageOf(error);
        const text = own ?? settle(error);
        if (text !== null) setLoadError(text);
      });
    return () => {
      generation.current++;
    };
  }, [
    companyId,
    settle,
    rangeFrom,
    rangeTo,
    view,
    resourceFilter,
    serviceFilter,
    statusFilter,
    attempt,
  ]);

  // Depois de abrir um dia na lista (toque no mês), leva o foco ao título do dia.
  useEffect(() => {
    if (focusDay === null || view !== 'list' || !loaded) return;
    const heading = document.getElementById(`dia-${focusDay}`);
    if (heading === null) return;
    heading.focus();
    heading.scrollIntoView({ block: 'start' });
    setFocusDay(null);
  }, [focusDay, view, loaded, items]);

  const failure = useCallback(
    (error: unknown, inDialog: boolean): void => {
      const own = agendaMessageOf(error);
      const text = own ?? settle(error);
      if (text === null) return;
      const known =
        own !== null || (error instanceof ApiError && OWN_MESSAGE_STATUSES.includes(error.status));
      const shown = known ? text : AGENDA_SAVE_FAILED;
      if (inDialog) setDialogProblem(shown);
      else setNotice({ tone: 'error', text: shown });
    },
    [settle],
  );

  const reload = (): void => setAttempt((value) => value + 1);

  const run = async (work: () => Promise<void>, inDialog: boolean): Promise<void> => {
    setBusy(true);
    setNotice(null);
    setDialogProblem(null);
    try {
      await work();
    } catch (error) {
      if (isSlotTaken(error)) {
        // O horário sumiu entre a consulta e a reserva: mensagem clara e os horários são relidos.
        setDialogProblem(SLOT_TAKEN_MESSAGE);
        setSlotsVersion((value) => value + 1);
      } else if (error instanceof ApiError && error.status === 404) {
        setDialog(null);
        setConfirm(null);
        setNotice({ tone: 'error', text: AGENDA_STALE_MESSAGE });
        reload();
      } else {
        failure(error, inDialog);
      }
    } finally {
      setBusy(false);
    }
  };

  const create = (values: {
    serviceId: string;
    resourceId: string;
    localStart: string;
    customerLabel: string;
  }): Promise<void> =>
    run(async () => {
      await agendaApi.createAppointment(companyId, {
        serviceId: values.serviceId,
        resourceId: values.resourceId,
        localStart: values.localStart,
        ...(values.customerLabel === '' ? {} : { customerLabel: values.customerLabel }),
      });
      setDialog(null);
      setNotice({ tone: 'success', text: 'Agendamento criado.' });
      reload();
    }, true);

  const act = (item: Appointment, action: ItemAction): Promise<void> =>
    run(async () => {
      if (action === 'unblock') {
        await agendaApi.deleteBlock(companyId, item.id);
      } else {
        const status =
          action === 'confirm'
            ? 'CONFIRMED'
            : action === 'cancel'
              ? 'CANCELLED'
              : action === 'complete'
                ? 'COMPLETED'
                : 'NO_SHOW';
        await agendaApi.patchAppointment(companyId, item.id, { status });
      }
      setDialog(null);
      setConfirm(null);
      setNotice({ tone: 'success', text: 'Agenda atualizada.' });
      reload();
    }, true);

  const reschedule = (item: Appointment, localStart: string): Promise<void> =>
    run(async () => {
      await agendaApi.patchAppointment(companyId, item.id, { localStart });
      setDialog(null);
      setNotice({ tone: 'success', text: 'Agendamento remarcado.' });
      reload();
    }, true);

  const block = (values: {
    resourceIds: string[];
    localStart: string;
    localEnd: string;
  }): Promise<void> =>
    run(async () => {
      await agendaApi.createBlocks(companyId, values);
      setDialog(null);
      setNotice({ tone: 'success', text: 'Horário bloqueado.' });
      reload();
    }, true);

  if (loadError !== null) {
    return (
      <div className="grid gap-4">
        <Problem text={loadError} />
        <div>
          <Button variant="outline" size="sm" onClick={reload}>
            Tentar de novo
          </Button>
        </div>
      </div>
    );
  }
  if (!loaded || start === null || month === null || cursor === null) {
    return (
      <div className="grid place-items-center gap-3 py-10 text-sm text-muted-foreground">
        <Loader variant="spinner" size={28} label="Carregando a agenda" />
        <span aria-hidden="true">Carregando a agenda…</span>
      </div>
    );
  }

  const days = groupByDay(items, weekDates(start));
  const step = (direction: 1 | -1): void =>
    setCursor(view === 'month' ? addMonths(month, direction) : addDays(start, 7 * direction));
  const openDay = (date: string, target: 'week' | 'list'): void => {
    setCursor(date);
    setView(target);
    if (target === 'list') setFocusDay(date);
  };
  const newAt = (initialStart: string): void => {
    setDialogProblem(null);
    setSlotsVersion(0);
    setDialog({ kind: 'new', initialStart });
  };
  const activeResources = resources.filter((resource) => resource.active);
  const openItem = (item: Appointment): void => {
    setDialogProblem(null);
    setSlotsVersion(0);
    setDialog({ kind: 'item', item });
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          className="flex flex-wrap items-center gap-2"
          role="group"
          aria-label={view === 'month' ? 'Mês' : 'Semana'}
        >
          <Button variant="outline" size="sm" onClick={() => step(-1)}>
            {view === 'month' ? 'Mês anterior' : 'Semana anterior'}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setCursor(today)}>
            Hoje
          </Button>
          <Button variant="outline" size="sm" onClick={() => step(1)}>
            {view === 'month' ? 'Próximo mês' : 'Próxima semana'}
          </Button>
        </div>
        <div
          className="flex flex-wrap items-center gap-2"
          role="group"
          aria-label="Visão da agenda"
        >
          {(['list', 'week', 'month'] as const).map((option) => (
            <Button
              key={option}
              variant={view === option ? 'primary' : 'outline'}
              size="sm"
              aria-pressed={view === option}
              onClick={() => setView(option)}
            >
              {VIEW_LABELS[option]}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canManage && <Button onClick={() => newAt('')}>Novo agendamento</Button>}
          {canManage && (
            <Button
              variant="outline"
              onClick={() => {
                setDialogProblem(null);
                setDialog({ kind: 'block' });
              }}
            >
              Bloquear horário
            </Button>
          )}
          {canConfigure && (
            <Button variant="outline" onClick={onConfigure}>
              Configurar agenda
            </Button>
          )}
        </div>
      </div>

      <h2 className="m-0 text-xl font-semibold first-letter:uppercase">
        {view === 'month' ? monthLabel(month) : weekLabel(start)}
      </h2>
      <p role="status" aria-live="polite" className="m-0 text-sm text-muted-foreground">
        {announcement}
      </p>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field id="filtro-servico" label="Serviço">
          <select
            id="filtro-servico"
            className={FIELD_CLASS}
            value={serviceFilter}
            onChange={(event) => setServiceFilter(event.target.value)}
          >
            <option value="">Todos os serviços</option>
            {services.map((service) => (
              <option key={service.id} value={service.id}>
                {service.name}
              </option>
            ))}
          </select>
        </Field>
        {activeResources.length > 1 && (
          <Field id="filtro-recurso" label="Recurso">
            <select
              id="filtro-recurso"
              className={FIELD_CLASS}
              value={resourceFilter}
              onChange={(event) => setResourceFilter(event.target.value)}
            >
              <option value="">Todos os recursos</option>
              {resources.map((resource) => (
                <option key={resource.id} value={resource.id}>
                  {resource.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field id="filtro-estado" label="Estado">
          <select
            id="filtro-estado"
            className={FIELD_CLASS}
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as AppointmentStatus | '')}
          >
            <option value="">Todos os estados</option>
            {APPOINTMENT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {view !== 'list' && tooLarge && (
        <div className="grid gap-3">
          <Problem text={RANGE_TOO_LARGE_MONTH_MESSAGE} />
          <div>
            <Button variant="outline" size="sm" onClick={() => setView('week')}>
              Ver a semana
            </Button>
          </div>
        </div>
      )}
      {view !== 'list' && !tooLarge && (
        <AgendaCalendar
          view={view}
          cursor={cursor}
          today={today}
          items={items}
          canManage={canManage}
          narrow={narrow}
          onOpenItem={openItem}
          onNewAt={newAt}
          onOpenDay={openDay}
        />
      )}
      <div className={view === 'list' ? 'grid gap-4' : 'hidden'}>
        {days.map((group) => (
          <section key={group.date} aria-labelledby={`dia-${group.date}`} className="grid gap-2">
            <h3
              id={`dia-${group.date}`}
              tabIndex={-1}
              className="m-0 flex items-center gap-2 text-base font-semibold outline-none focus-visible:outline-3 focus-visible:outline-ring"
            >
              <span className="first-letter:uppercase">{dayHeading(group.date)}</span>
              {group.date === today && <Chip>Hoje</Chip>}
            </h3>
            {group.items.length === 0 ? (
              <p className="m-0 text-sm text-muted-foreground">Nenhum agendamento.</p>
            ) : (
              <ul className="m-0 grid list-none gap-2 p-0">
                {group.items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => openItem(item)}
                      className={`flex w-full flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card p-3 text-left text-sm text-card-foreground focus-visible:outline-3 focus-visible:outline-ring ${item.status === 'CANCELLED' ? 'opacity-70' : ''}`}
                    >
                      <span className="min-w-0 [overflow-wrap:anywhere]">
                        <span className="font-medium">
                          {item.localStart} às {item.localEnd}
                        </span>
                        {item.kind === 'BLOCK' ? null : (
                          <span>{` · ${item.serviceName ?? 'Serviço'}`}</span>
                        )}
                        {item.kind !== 'BLOCK' && who(item) !== null ? (
                          <span>{` · ${who(item) ?? ''}`}</span>
                        ) : null}
                      </span>
                      <StatusBadge item={item} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>

      <p className="m-0 text-sm text-muted-foreground">Horários no fuso {timezone}.</p>
      <PrivacyNote />

      <Modal open={dialog?.kind === 'new'} title="Novo agendamento" onClose={() => setDialog(null)}>
        {dialog?.kind === 'new' && (
          <NewAppointmentDialog
            companyId={companyId}
            today={today}
            initialStart={dialog.initialStart}
            services={services}
            resources={resources}
            busy={busy}
            problem={dialogProblem}
            slotsVersion={slotsVersion}
            settle={settle}
            canConfigure={canConfigure}
            onSubmit={(values) => void create(values)}
          />
        )}
      </Modal>
      <Modal
        open={dialog?.kind === 'item'}
        title={dialog?.kind === 'item' && dialog.item.kind === 'BLOCK' ? 'Bloqueio' : 'Agendamento'}
        onClose={() => setDialog(null)}
      >
        {dialog?.kind === 'item' && (
          <ItemDialog
            key={dialog.item.id}
            companyId={companyId}
            item={dialog.item}
            canManage={canManage}
            started={hasStarted(dialog.item.startsAt, Date.now())}
            today={today}
            resources={resources}
            busy={busy}
            problem={dialogProblem}
            slotsVersion={slotsVersion}
            settle={settle}
            onAction={(action) => {
              if (action === 'cancel' || action === 'unblock') setConfirm(dialog.item);
              else void act(dialog.item, action);
            }}
            onReschedule={(localStart) => void reschedule(dialog.item, localStart)}
          />
        )}
      </Modal>
      <Modal
        open={dialog?.kind === 'block'}
        title="Bloquear horário"
        onClose={() => setDialog(null)}
      >
        {dialog?.kind === 'block' && (
          <BlockDialog
            today={today}
            resources={resources}
            items={items}
            busy={busy}
            problem={dialogProblem}
            onSubmit={(values) => void block(values)}
          />
        )}
      </Modal>
      <ConfirmDialog
        request={
          confirm === null
            ? null
            : confirm.kind === 'BLOCK'
              ? {
                  title: 'Remover o bloqueio?',
                  text: 'O horário volta a ficar livre para novos agendamentos.',
                  confirmLabel: 'Remover bloqueio',
                }
              : {
                  title: 'Cancelar o agendamento?',
                  text: 'O horário volta a ficar livre. O cancelamento não pode ser desfeito: um novo agendamento precisa ser criado.',
                  confirmLabel: 'Cancelar agendamento',
                }
        }
        busy={busy}
        onConfirm={() => {
          if (confirm !== null) void act(confirm, confirm.kind === 'BLOCK' ? 'unblock' : 'cancel');
        }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
