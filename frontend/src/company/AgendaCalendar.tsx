import {
  Ban,
  CheckCheck,
  CheckCircle2,
  Clock,
  UserX,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { MouseEvent } from 'react';
import type { Appointment, AppointmentStatus } from './agenda-api';
import { dayHeading, STATUS_LABELS, weekDates, weekStart } from './agenda-rules';
import {
  axisHours,
  blockPosition,
  dayOfMonth,
  itemAccessibleName,
  monthCells,
  monthItemText,
  monthNameOf,
  startAtOffset,
  timeLabel,
  visibleRange,
  weekBlocks,
  type DayBlock,
} from './calendar-rules';

/** Altura de uma hora na grade da semana (px): 30 minutos ficam com duas linhas de texto. */
const HOUR_PX = 72;
const SHORT_WEEKDAYS: readonly string[] = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'];

const STATUS_ICONS: Readonly<Record<AppointmentStatus, LucideIcon>> = {
  PENDING: Clock,
  CONFIRMED: CheckCircle2,
  CANCELLED: XCircle,
  COMPLETED: CheckCheck,
  NO_SHOW: UserX,
};

const who = (item: Appointment): string | null => item.customerLabel ?? item.contactLabel;

/** Estado do item em texto e ícone (nunca só cor): bloqueio vira "Bloqueado". */
function stateOf(item: Appointment): { Icon: LucideIcon; text: string } {
  if (item.kind === 'BLOCK' && item.status !== 'CANCELLED') return { Icon: Ban, text: 'Bloqueado' };
  return { Icon: STATUS_ICONS[item.status], text: STATUS_LABELS[item.status] };
}

export interface AgendaCalendarProps {
  readonly view: 'week' | 'month';
  /** Qualquer dia do período mostrado (a semana e o mês saem dele). */
  readonly cursor: string;
  readonly today: string;
  readonly items: readonly Appointment[];
  readonly canManage: boolean;
  /** Abaixo de 768 px: a semana rola na horizontal e o mês mostra só a contagem por dia. */
  readonly narrow: boolean;
  readonly onOpenItem: (item: Appointment) => void;
  /** Novo agendamento com a data (e a hora, na semana) já preenchidas: `YYYY-MM-DD` ou `YYYY-MM-DDTHH:mm`. */
  readonly onNewAt: (localStart: string) => void;
  /** "+N" do mês (abre o dia na semana) e toque no dia no celular (abre a lista do dia). */
  readonly onOpenDay: (date: string, target: 'week' | 'list') => void;
}

/**
 * Calendário da agenda (spec 029, E4): semana (CSS Grid, blocos posicionados pelos minutos de `localStart` a
 * `localEnd`) e mês (grade de 6 semanas). Cada dia é uma região com título e cada item é um `<button>` com nome
 * acessível completo, na ordem do tempo (a lista por dia continua sendo a alternativa acessível completa). Só
 * usa os campos que o servidor devolve; nada de fuso no navegador.
 */
export function AgendaCalendar(props: AgendaCalendarProps) {
  return props.view === 'week' ? <WeekGrid {...props} /> : <MonthGrid {...props} />;
}

function ItemBlock({
  block,
  range,
  onOpenItem,
}: {
  block: DayBlock;
  range: { start: number; end: number };
  onOpenItem: (item: Appointment) => void;
}) {
  const { item } = block;
  const position = blockPosition(block, range);
  const { Icon, text } = stateOf(item);
  const person = item.kind === 'BLOCK' ? null : who(item);
  const gap = 4;
  return (
    <li
      className="pointer-events-auto absolute"
      style={{
        top: `${String(position.top)}%`,
        height: `${String(position.height)}%`,
        left: `calc(${String((block.column / block.columns) * 100)}% + ${String(gap / 2)}px)`,
        width: `calc(${String(100 / block.columns)}% - ${String(gap)}px)`,
      }}
    >
      <button
        type="button"
        onClick={() => onOpenItem(item)}
        title={itemAccessibleName(item)}
        aria-label={`${itemAccessibleName(item)}${block.continuesFromPrevious ? ', continuação do dia anterior' : ''}${block.continuesToNext ? ', continua no dia seguinte' : ''}`}
        className={`flex size-full flex-col items-start gap-0.5 overflow-hidden rounded-lg border border-border bg-card p-1.5 text-left text-xs leading-tight text-card-foreground focus-visible:outline-3 focus-visible:outline-ring ${item.status === 'CANCELLED' ? 'opacity-70' : ''}`}
      >
        <span className="inline-flex max-w-full items-start gap-1 font-medium">
          <Icon aria-hidden="true" className="mt-px size-3 shrink-0" />
          <span className="[overflow-wrap:anywhere]">
            {block.continuesFromPrevious ? '↤ ' : ''}
            {item.localStart} às {item.localEnd}
            {block.continuesToNext ? ' ↦' : ''} · {text}
          </span>
        </span>
        {item.kind === 'BLOCK' ? null : (
          <span className="[overflow-wrap:anywhere]">
            {item.serviceName ?? 'Serviço'}
            {person === null ? '' : ` · ${person}`}
          </span>
        )}
      </button>
    </li>
  );
}

function WeekGrid({ cursor, today, items, canManage, onOpenItem, onNewAt }: AgendaCalendarProps) {
  const dates = weekDates(weekStart(cursor));
  const byDay = weekBlocks(items, dates);
  const range = visibleRange([...byDay.values()].flat());
  const hours = axisHours(range);
  const bodyHeight = ((range.end - range.start) / 60) * HOUR_PX;
  const clickEmpty = (date: string) => (event: MouseEvent<HTMLDivElement>) => {
    if (!canManage || event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    onNewAt(startAtOffset(date, range, (event.clientY - rect.top) / rect.height));
  };

  return (
    <div
      className="relative overflow-x-auto rounded-xl border border-border bg-card"
      data-testid="week-grid"
    >
      <div
        className="grid min-w-[46rem]"
        style={{ gridTemplateColumns: '3.5rem repeat(7, minmax(0, 1fr))' }}
      >
        <div className="sticky left-0 z-10 border-r border-border bg-card">
          <div className="h-14 border-b border-border" aria-hidden="true" />
          <div
            className="relative"
            style={{ height: `${String(bodyHeight)}px` }}
            aria-hidden="true"
          >
            {hours.map((minute) => (
              <span
                key={minute}
                className="absolute right-1 -translate-y-1/2 text-xs text-muted-foreground"
                style={{
                  top: `${String(((minute - range.start) / (range.end - range.start)) * 100)}%`,
                }}
              >
                {timeLabel(minute)}
              </span>
            ))}
          </div>
        </div>
        {dates.map((date, index) => {
          const isToday = date === today;
          return (
            <section
              key={date}
              aria-labelledby={`semana-${date}`}
              className="min-w-0 border-r border-border last:border-r-0"
            >
              <div
                className={`flex h-14 flex-col items-center justify-center gap-0.5 border-b border-border px-1 text-center ${isToday ? 'bg-muted font-semibold' : ''}`}
              >
                <h3 id={`semana-${date}`} className="m-0 text-sm font-medium">
                  <span className="sr-only">{dayHeading(date)}</span>
                  <span aria-hidden="true" className="uppercase">
                    {SHORT_WEEKDAYS[index]} {dayOfMonth(date)}
                  </span>
                </h3>
                {isToday && (
                  <span className="rounded-full border border-foreground px-2 text-xs">Hoje</span>
                )}
                {canManage && (
                  <button
                    type="button"
                    onClick={() => onNewAt(date)}
                    className="rounded-md px-1 text-xs text-muted-foreground underline focus-visible:outline-3 focus-visible:outline-ring"
                    aria-label={`Novo agendamento em ${dayHeading(date)}`}
                  >
                    Agendar
                  </button>
                )}
              </div>
              {/* Clique na faixa vazia (só com permissão): abre "Novo agendamento" com data e hora. */}
              <div
                className={`relative ${canManage ? 'cursor-pointer' : ''}`}
                style={{ height: `${String(bodyHeight)}px` }}
                onClick={clickEmpty(date)}
                data-testid={`dia-${date}`}
              >
                {hours.map((minute) => (
                  <div
                    key={minute}
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 border-t border-border"
                    style={{
                      top: `${String(((minute - range.start) / (range.end - range.start)) * 100)}%`,
                    }}
                  />
                ))}
                {(byDay.get(date) ?? []).length === 0 ? (
                  <p className="sr-only">Nenhum agendamento.</p>
                ) : (
                  <ul className="pointer-events-none absolute inset-0 m-0 list-none p-0">
                    {(byDay.get(date) ?? []).map((block) => (
                      <ItemBlock
                        key={`${block.item.id}-${block.date}`}
                        block={block}
                        range={range}
                        onOpenItem={onOpenItem}
                      />
                    ))}
                  </ul>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function MonthGrid({
  cursor,
  today,
  items,
  canManage,
  narrow,
  onOpenItem,
  onNewAt,
  onOpenDay,
}: AgendaCalendarProps) {
  const cells = monthCells(items, cursor);
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="grid grid-cols-7 border-b border-border" aria-hidden="true">
        {SHORT_WEEKDAYS.map((name) => (
          <div key={name} className="p-1 text-center text-xs font-medium uppercase">
            {name}
          </div>
        ))}
      </div>
      <ol
        className="m-0 grid list-none grid-cols-7 p-0"
        aria-label="Dias do mês, de segunda a domingo"
      >
        {cells.map((cell) => {
          const isToday = cell.date === today;
          const heading = `${dayHeading(cell.date)}${cell.inMonth ? '' : ` (${monthNameOf(cell.date)})`}`;
          const count = `${String(cell.total)} ${cell.total === 1 ? 'agendamento' : 'agendamentos'}`;
          return (
            <li
              key={cell.date}
              className={`min-w-0 border-b border-r border-border p-1 ${narrow ? 'min-h-14' : 'min-h-28'} ${cell.inMonth ? '' : 'bg-muted text-muted-foreground'}`}
            >
              {narrow ? (
                <button
                  type="button"
                  onClick={() => onOpenDay(cell.date, 'list')}
                  aria-label={`${heading}, ${count}. Ver o dia`}
                  className={`flex size-full min-h-12 flex-col items-center justify-start gap-1 rounded-md text-sm focus-visible:outline-3 focus-visible:outline-ring ${isToday ? 'font-bold underline' : ''}`}
                >
                  <span aria-hidden="true">{dayOfMonth(cell.date)}</span>
                  {cell.total > 0 && (
                    <span
                      aria-hidden="true"
                      className="rounded-full border border-border bg-card px-1.5 text-xs text-card-foreground"
                    >
                      {cell.total}
                    </span>
                  )}
                </button>
              ) : (
                <div className="grid gap-1">
                  <div className="flex items-center justify-between gap-1">
                    {canManage ? (
                      <button
                        type="button"
                        onClick={() => onNewAt(cell.date)}
                        aria-label={`Novo agendamento em ${heading}`}
                        className={`rounded-md px-1.5 text-sm hover:bg-muted focus-visible:outline-3 focus-visible:outline-ring ${isToday ? 'border border-foreground font-bold' : ''}`}
                      >
                        {dayOfMonth(cell.date)}
                      </button>
                    ) : (
                      <span
                        className={`px-1.5 text-sm ${isToday ? 'rounded-md border border-foreground font-bold' : ''}`}
                      >
                        <span className="sr-only">{heading}: </span>
                        <span aria-hidden="true">{dayOfMonth(cell.date)}</span>
                      </span>
                    )}
                    {isToday && <span className="text-xs">Hoje</span>}
                  </div>
                  <ul className="m-0 grid list-none gap-0.5 p-0">
                    {cell.shown.map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          onClick={() => onOpenItem(item)}
                          title={itemAccessibleName(item)}
                          aria-label={itemAccessibleName(item)}
                          className={`block w-full truncate rounded-md border border-border bg-card px-1 text-left text-xs text-card-foreground focus-visible:outline-3 focus-visible:outline-ring ${item.status === 'CANCELLED' ? 'opacity-70' : ''}`}
                        >
                          <span className="sr-only">{stateOf(item).text}</span>
                          <span aria-hidden="true">{monthItemText(item)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {cell.extra > 0 && (
                    <button
                      type="button"
                      onClick={() => onOpenDay(cell.date, 'week')}
                      aria-label={`Mais ${String(cell.extra)} em ${heading}. Abrir o dia na semana`}
                      className="rounded-md text-left text-xs underline focus-visible:outline-3 focus-visible:outline-ring"
                    >
                      +{cell.extra}
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
