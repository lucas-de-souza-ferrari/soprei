import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, AlertContent, AlertDescription, AlertIcon } from '../components/motion/alert';
import { Button } from '../components/motion/button';
import { Input } from '../components/motion/input';
import {
  type AgendaResource,
  type AgendaService,
  agendaApi,
  agendaMessageOf,
  type Appointment,
  type Slot,
} from './agenda-api';
import {
  ACTION_LABELS,
  addDays,
  allowedActions,
  BY_AI_LABEL,
  customerLabelProblem,
  dayHeading,
  isByAi,
  type ItemAction,
  localStartOf,
  minutesOf,
  statusLabelOf,
} from './agenda-rules';

export const FIELD_CLASS =
  'h-12 w-full rounded-xl border border-input bg-background px-3 text-base text-foreground focus-visible:outline-3 focus-visible:outline-ring';

export const PRIVACY_NOTICE =
  'Não registre motivo de consulta, exame, diagnóstico ou outro dado de saúde: use só o nome.';

export function Problem({ text }: { text: string | null }) {
  return (
    <div aria-live="polite">
      {text !== null && (
        <Alert variant="destructive">
          <AlertIcon />
          <AlertContent>
            <AlertDescription className="text-inherit">{text}</AlertDescription>
          </AlertContent>
        </Alert>
      )}
    </div>
  );
}

export function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="px-1 text-sm font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}

export function PrivacyNote() {
  return (
    <p className="m-0 rounded-2xl border border-border bg-muted p-3 text-sm text-foreground">
      {PRIVACY_NOTICE}
    </p>
  );
}

interface SlotPickerProps {
  readonly companyId: string;
  readonly serviceId: string;
  readonly resourceId: string;
  readonly resources: readonly AgendaResource[];
  readonly date: string;
  /** Muda quando o conflito (`SLOT_TAKEN`) pede nova leitura dos horários. */
  readonly version: number;
  readonly picked: string | null;
  readonly settle: (error: unknown) => string | null;
  readonly onPick: (slot: Slot) => void;
}

/**
 * Horários livres de um dia, lidos do servidor (`availability`). Sugestão apenas: quem garante é a
 * reserva (`SLOT_TAKEN`). Horário e data são os campos `local*` da resposta, nunca calculados aqui.
 */
export function SlotPicker({
  companyId,
  serviceId,
  resourceId,
  resources,
  date,
  version,
  picked,
  settle,
  onPick,
}: SlotPickerProps) {
  const [slots, setSlots] = useState<readonly Slot[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    if (date === '') return;
    const stamp = ++generation.current;
    setSlots(null);
    setProblem(null);
    agendaApi
      .availability(companyId, { serviceId, resourceId, from: date, to: date })
      .then((result) => {
        if (stamp === generation.current) setSlots(result.slots);
      })
      .catch((error: unknown) => {
        if (stamp !== generation.current) return;
        const text = agendaMessageOf(error) ?? settle(error);
        if (text !== null) setProblem(text);
        setSlots([]);
      });
    return () => {
      generation.current++;
    };
  }, [companyId, serviceId, resourceId, date, version, settle]);

  if (date === '') return <p className="m-0 text-sm text-muted-foreground">Escolha a data.</p>;
  if (slots === null) {
    return <p className="m-0 text-sm text-muted-foreground">Procurando horários livres…</p>;
  }
  const name = resources.find((resource) => resource.id === resourceId)?.name ?? '';
  return (
    <div className="grid gap-2">
      <Problem text={problem} />
      {slots.length === 0 && problem === null ? (
        <p className="m-0 text-sm text-muted-foreground">
          Sem horários livres neste dia{resources.length > 1 ? ` em ${name}` : ''}. Escolha outra
          data ou use o encaixe.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label="Horários livres">
          {slots.map((slot) => (
            <li key={`${slot.localDate}-${slot.localStart}`}>
              <Button
                type="button"
                size="sm"
                variant={picked === slot.localStart ? 'primary' : 'outline'}
                aria-pressed={picked === slot.localStart}
                onClick={() => onPick(slot)}
              >
                {slot.localStart}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface NewAppointmentDialogProps {
  readonly companyId: string;
  readonly today: string;
  readonly services: readonly AgendaService[];
  readonly resources: readonly AgendaResource[];
  readonly busy: boolean;
  readonly problem: string | null;
  readonly slotsVersion: number;
  readonly settle: (error: unknown) => string | null;
  readonly canConfigure: boolean;
  /** Data (`YYYY-MM-DD`) ou data e hora (`YYYY-MM-DDTHH:mm`) vindas de um clique no calendário. */
  readonly initialStart?: string | undefined;
  readonly onSubmit: (values: {
    serviceId: string;
    resourceId: string;
    localStart: string;
    customerLabel: string;
  }) => void;
}

/** Novo agendamento: serviço, recurso (oculto se houver um só), data, horário livre ou encaixe e nome. */
export function NewAppointmentDialog({
  companyId,
  today,
  services,
  resources,
  busy,
  problem,
  slotsVersion,
  settle,
  canConfigure,
  initialStart,
  onSubmit,
}: NewAppointmentDialogProps) {
  const activeServices = services.filter((service) => service.active);
  const activeResources = resources.filter((resource) => resource.active);
  const [serviceId, setServiceId] = useState(activeServices[0]?.id ?? '');
  const [resourceId, setResourceId] = useState(activeResources[0]?.id ?? '');
  // Aberto pelo calendário (spec 029): a data (e a hora, quando veio da faixa da semana) já preenchidas; o
  // servidor continua sendo quem valida (a lista de horários livres é só sugestão).
  const preset = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?$/.exec(initialStart ?? '');
  const [date, setDate] = useState(preset?.[1] ?? today);
  const [picked, setPicked] = useState<string | null>(null);
  const [fit, setFit] = useState(preset?.[2] !== undefined);
  const [fitTime, setFitTime] = useState(preset?.[2] ?? '');
  const [name, setName] = useState('');
  const [local, setLocal] = useState<string | null>(null);

  if (activeServices.length === 0 || activeResources.length === 0) {
    return (
      <p className="m-0 text-sm">
        {activeServices.length === 0
          ? 'Cadastre ao menos um serviço ativo'
          : 'Ative ao menos um recurso'}
        {canConfigure ? ' em “Configurar agenda”.' : ' (peça a quem administra a empresa).'}
      </p>
    );
  }

  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const time = fit ? fitTime : picked;
        if (time === null || minutesOf(time) === null || date === '') {
          setLocal(fit ? 'Informe o horário do encaixe.' : 'Escolha um horário livre.');
          return;
        }
        const nameProblem = customerLabelProblem(name);
        if (nameProblem !== null) {
          setLocal(nameProblem);
          return;
        }
        onSubmit({
          serviceId,
          resourceId,
          localStart: localStartOf(date, time),
          customerLabel: name.trim(),
        });
      }}
    >
      <Problem text={local ?? problem} />
      <Field id="agenda-servico" label="Serviço">
        <select
          id="agenda-servico"
          className={FIELD_CLASS}
          value={serviceId}
          onChange={(event) => {
            setServiceId(event.target.value);
            setPicked(null);
          }}
        >
          {activeServices.map((service) => (
            <option key={service.id} value={service.id}>
              {service.name} ({String(service.durationMinutes)} min)
            </option>
          ))}
        </select>
      </Field>
      {activeResources.length > 1 && (
        <Field id="agenda-recurso" label="Profissional ou recurso">
          <select
            id="agenda-recurso"
            className={FIELD_CLASS}
            value={resourceId}
            onChange={(event) => {
              setResourceId(event.target.value);
              setPicked(null);
            }}
          >
            {activeResources.map((resource) => (
              <option key={resource.id} value={resource.id}>
                {resource.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Input
        label="Data"
        type="date"
        value={date}
        onChange={(value) => {
          setDate(value);
          setPicked(null);
          setLocal(null);
        }}
      />
      <div className="grid gap-1.5">
        <span className="px-1 text-sm font-medium">Horário</span>
        {fit ? (
          <div className="grid gap-2">
            <Input
              label="Horário do encaixe"
              type="time"
              value={fitTime}
              onChange={(value) => {
                setFitTime(value);
                setLocal(null);
              }}
            />
            <p className="m-0 text-sm text-muted-foreground">
              Encaixe: pode ficar fora do horário configurado, mas nunca sobre outro agendamento.
            </p>
          </div>
        ) : (
          <SlotPicker
            companyId={companyId}
            serviceId={serviceId}
            resourceId={resourceId}
            resources={resources}
            date={date}
            version={slotsVersion}
            picked={picked}
            settle={settle}
            onPick={(slot) => {
              setPicked(slot.localStart);
              setLocal(null);
            }}
          />
        )}
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setFit((value) => !value);
              setLocal(null);
            }}
          >
            {fit ? 'Escolher entre os horários livres' : 'Encaixe fora do horário configurado'}
          </Button>
        </div>
      </div>
      <Input
        label="Nome de quem será atendido (opcional)"
        value={name}
        maxLength={60}
        onChange={(value) => {
          setName(value);
          setLocal(null);
        }}
      />
      <PrivacyNote />
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? 'Aguarde…' : 'Agendar'}
        </Button>
      </div>
    </form>
  );
}

export interface ItemDialogProps {
  readonly companyId: string;
  readonly item: Appointment;
  readonly canManage: boolean;
  readonly started: boolean;
  readonly today: string;
  readonly resources: readonly AgendaResource[];
  readonly busy: boolean;
  readonly problem: string | null;
  readonly slotsVersion: number;
  readonly settle: (error: unknown) => string | null;
  readonly onAction: (action: ItemAction) => void;
  readonly onReschedule: (localStart: string) => void;
}

/** Detalhe de um agendamento ou bloqueio, com as ações permitidas pelo estado. */
export function ItemDialog({
  companyId,
  item,
  canManage,
  started,
  today,
  resources,
  busy,
  problem,
  slotsVersion,
  settle,
  onAction,
  onReschedule,
}: ItemDialogProps) {
  const [moving, setMoving] = useState(false);
  const [date, setDate] = useState(item.localDate > today ? item.localDate : today);
  const [picked, setPicked] = useState<string | null>(null);
  const actions = canManage ? allowedActions(item, started) : [];
  const who = item.customerLabel ?? item.contactLabel;
  return (
    <div className="grid gap-3">
      <Problem text={problem} />
      <dl className="m-0 grid gap-1 text-sm">
        <div>
          <dt className="inline text-muted-foreground">Dia: </dt>
          <dd className="m-0 inline">{dayHeading(item.localDate)}</dd>
        </div>
        <div>
          <dt className="inline text-muted-foreground">Horário: </dt>
          <dd className="m-0 inline">
            {item.localStart} às {item.localEnd}
          </dd>
        </div>
        {item.kind === 'BOOKING' && (
          <div>
            <dt className="inline text-muted-foreground">Serviço: </dt>
            <dd className="m-0 inline [overflow-wrap:anywhere]">{item.serviceName ?? '—'}</dd>
          </div>
        )}
        {resources.length > 1 && item.resourceName !== null && (
          <div>
            <dt className="inline text-muted-foreground">Recurso: </dt>
            <dd className="m-0 inline [overflow-wrap:anywhere]">{item.resourceName}</dd>
          </div>
        )}
        {who !== null && (
          <div>
            <dt className="inline text-muted-foreground">Atendido: </dt>
            <dd className="m-0 inline [overflow-wrap:anywhere]">{who}</dd>
          </div>
        )}
        <div>
          <dt className="inline text-muted-foreground">Situação: </dt>
          <dd className="m-0 inline">
            {item.kind === 'BLOCK' && item.status !== 'CANCELLED'
              ? 'Bloqueado'
              : statusLabelOf(item)}
          </dd>
        </div>
        {isByAi(item) && (
          <div>
            <dt className="inline text-muted-foreground">Origem: </dt>
            <dd className="m-0 inline">
              {BY_AI_LABEL} (pedido feito pela conversa de atendimento)
            </dd>
          </div>
        )}
      </dl>
      {actions.length === 0 && (
        <p className="m-0 text-sm text-muted-foreground">
          {canManage
            ? 'Nenhuma ação disponível para este item.'
            : 'Você pode ver, mas não alterar.'}
        </p>
      )}
      {!moving && (
        <div className="flex flex-wrap gap-2">
          {actions.map((action) => (
            <Button
              key={action}
              variant={action === 'cancel' || action === 'unblock' ? 'outline' : 'primary'}
              size="sm"
              disabled={busy}
              onClick={() => {
                if (action === 'reschedule') setMoving(true);
                else onAction(action);
              }}
            >
              {ACTION_LABELS[action]}
            </Button>
          ))}
        </div>
      )}
      {moving && item.serviceId !== null && (
        <div className="grid gap-3 rounded-2xl border border-border p-3">
          <h3 className="m-0 text-base font-semibold">Remarcar para</h3>
          <Input
            label="Nova data"
            type="date"
            value={date}
            onChange={(value) => {
              setDate(value);
              setPicked(null);
            }}
          />
          <SlotPicker
            companyId={companyId}
            serviceId={item.serviceId}
            resourceId={item.resourceId}
            resources={resources}
            date={date}
            version={slotsVersion}
            picked={picked}
            settle={settle}
            onPick={(slot) => setPicked(slot.localStart)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy || picked === null}
              onClick={() => {
                if (picked !== null) onReschedule(localStartOf(date, picked));
              }}
            >
              {busy ? 'Aguarde…' : 'Remarcar para este horário'}
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setMoving(false)}>
              Voltar
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export interface BlockDialogProps {
  readonly today: string;
  readonly resources: readonly AgendaResource[];
  /** Itens já carregados da semana: avisam de agendamento dentro do intervalo. */
  readonly items: readonly Appointment[];
  readonly busy: boolean;
  readonly problem: string | null;
  readonly onSubmit: (values: {
    resourceIds: string[];
    localStart: string;
    localEnd: string;
  }) => void;
}

/** Fim de um item como `YYYY-MM-DDTHH:mm` local (vira o dia seguinte se o fim cruza a meia-noite). */
function itemEnd(item: Appointment): string {
  const endDate = item.localEnd <= item.localStart ? addDays(item.localDate, 1) : item.localDate;
  return localStartOf(endDate, item.localEnd);
}

/** Itens ativos que o bloqueio pediria para tocar (comparação de texto local, sem fuso). */
export function conflictingItems(
  items: readonly Appointment[],
  resourceIds: readonly string[],
  start: string,
  end: string,
): Appointment[] {
  return items.filter(
    (item) =>
      (item.status === 'PENDING' || item.status === 'CONFIRMED') &&
      resourceIds.includes(item.resourceId) &&
      localStartOf(item.localDate, item.localStart) < end &&
      itemEnd(item) > start,
  );
}

/** Bloquear horário (folga, feriado, manutenção): um bloqueio por recurso escolhido. */
export function BlockDialog({
  today,
  resources,
  items,
  busy,
  problem,
  onSubmit,
}: BlockDialogProps) {
  const active = resources.filter((resource) => resource.active);
  const [chosen, setChosen] = useState<string[]>(
    active.length === 1 ? active.map((r) => r.id) : [],
  );
  const [startDate, setStartDate] = useState(today);
  const [startTime, setStartTime] = useState('09:00');
  const [endDate, setEndDate] = useState(today);
  const [endTime, setEndTime] = useState('18:00');
  const [local, setLocal] = useState<string | null>(null);
  const start = localStartOf(startDate, startTime);
  const end = localStartOf(endDate, endTime);
  const conflicts = conflictingItems(items, chosen, start, end);

  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (chosen.length === 0) {
          setLocal('Escolha ao menos um recurso.');
          return;
        }
        if (
          minutesOf(startTime) === null ||
          minutesOf(endTime) === null ||
          startDate === '' ||
          endDate === ''
        ) {
          setLocal('Informe o início e o fim.');
          return;
        }
        if (end <= start) {
          setLocal('O fim deve ser depois do início.');
          return;
        }
        onSubmit({ resourceIds: chosen, localStart: start, localEnd: end });
      }}
    >
      <Problem text={local ?? problem} />
      {active.length > 1 && (
        <fieldset className="grid gap-2 rounded-xl border border-border p-3">
          <legend className="px-1 text-sm font-medium">Recursos</legend>
          {active.map((resource) => (
            <label key={resource.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-5"
                checked={chosen.includes(resource.id)}
                onChange={(event) => {
                  setLocal(null);
                  setChosen((current) =>
                    event.target.checked
                      ? [...current, resource.id]
                      : current.filter((id) => id !== resource.id),
                  );
                }}
              />
              {resource.name}
            </label>
          ))}
        </fieldset>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="Data de início" type="date" value={startDate} onChange={setStartDate} />
        <Input label="Hora de início" type="time" value={startTime} onChange={setStartTime} />
        <Input label="Data de fim" type="date" value={endDate} onChange={setEndDate} />
        <Input label="Hora de fim" type="time" value={endTime} onChange={setEndTime} />
      </div>
      {conflicts.length > 0 && (
        <p className="m-0 rounded-2xl border border-border bg-muted p-3 text-sm text-foreground">
          Há {String(conflicts.length)} {conflicts.length === 1 ? 'agendamento' : 'agendamentos'}{' '}
          nesse período. Cancele ou remarque antes de bloquear.
        </p>
      )}
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? 'Aguarde…' : 'Bloquear'}
        </Button>
      </div>
    </form>
  );
}
