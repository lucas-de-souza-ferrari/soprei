import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { pageForPath, pathForPage } from '../account-flow';
import { ApiError } from '../api';
import {
  AGENDA_INVALID_MESSAGE,
  agendaMessageOf,
  appointmentSchema,
  isSlotTaken,
  SLOT_TAKEN_MESSAGE,
  type Appointment,
} from './agenda-api';
import {
  addDays,
  allowedActions,
  customerLabelProblem,
  dayHeading,
  groupByDay,
  hasStarted,
  isoWeekday,
  itemSummary,
  serviceFormProblem,
  STATUS_LABELS,
  weekAnnouncement,
  weekDates,
  weekLabel,
  weekStart,
  windowsProblem,
} from './agenda-rules';
import { conflictingItems } from './AgendaDialogs';
import { allowedPages, AREA_PAGES, areaPageForPath, canOpen, isAreaPage } from './company-nav';

const ID = '0195f3a0-aaaa-7bbb-8ccc-1234567890ab';
const OTHER_ID = '0195f3a0-aaaa-7bbb-8ccc-1234567890ac';

const item = (over: Partial<Appointment> = {}): Appointment => ({
  id: ID,
  kind: 'BOOKING',
  status: 'CONFIRMED',
  source: 'PANEL',
  resourceId: ID,
  resourceName: 'Agenda principal',
  serviceId: ID,
  serviceName: 'Corte de cabelo',
  startsAt: '2026-12-01T13:00:00.000Z',
  endsAt: '2026-12-01T13:30:00.000Z',
  localDate: '2026-12-01',
  localStart: '10:00',
  localEnd: '10:30',
  weekday: 2,
  customerLabel: 'João',
  contactLabel: null,
  createdAt: '2026-11-09T11:00:00.000Z',
  ...over,
});

test('a aba Agenda fica depois de Conversas e só abre com schedule:read; a configuração é tela escondida', () => {
  const order = [...AREA_PAGES];
  assert.equal(order.indexOf('agenda'), order.indexOf('conversas') + 1);
  assert.equal(areaPageForPath('/painel/agenda'), 'agenda');
  assert.equal(areaPageForPath('/painel/agenda/configurar'), 'agendaConfig');
  assert.equal(pageForPath('/painel/agenda'), 'agenda');
  assert.equal(pageForPath('/painel/agenda/configurar'), 'agendaConfig');
  assert.equal(pathForPage('agendaConfig'), '/painel/agenda/configurar');
  assert.equal(isAreaPage('agendaConfig'), true);
  assert.equal(canOpen('agenda', ['schedule:read']), true);
  assert.equal(canOpen('agenda', ['schedule:manage']), false);
  assert.equal(canOpen('agendaConfig', ['schedule:read', 'schedule:manage']), false);
  assert.equal(canOpen('agendaConfig', ['schedule:configure']), true);
  // A configuração nunca vira aba do menu.
  const owner = ['conversation:read', 'schedule:read', 'schedule:configure'];
  assert.ok(!(allowedPages(owner) as string[]).includes('agendaConfig'));
  assert.ok(allowedPages(['conversation:read', 'schedule:read']).includes('agenda'));
  assert.ok(!allowedPages(['conversation:read']).includes('agenda'));
});

test('mensagens por error.code: conflito, passado, recurso com agendamentos e transição', () => {
  const error = (status: number, code?: string) =>
    new ApiError(status, 'texto do servidor secreto', code);
  assert.equal(agendaMessageOf(error(409, 'SLOT_TAKEN')), SLOT_TAKEN_MESSAGE);
  assert.match(agendaMessageOf(error(400, 'IN_THE_PAST')) ?? '', /já passou/);
  assert.match(
    agendaMessageOf(error(409, 'RESOURCE_HAS_APPOINTMENTS')) ?? '',
    /agendamentos futuros/,
  );
  assert.match(agendaMessageOf(error(409, 'INVALID_TRANSITION')) ?? '', /não pode mudar/);
  assert.equal(agendaMessageOf(error(400)), AGENDA_INVALID_MESSAGE);
  assert.equal(agendaMessageOf(error(403)), null);
  assert.equal(agendaMessageOf(new Error('x')), null);
  for (const code of ['SLOT_TAKEN', 'IN_THE_PAST', 'INVALID_TRANSITION']) {
    assert.equal((agendaMessageOf(error(409, code)) ?? '').includes('secreto'), false);
  }
  assert.equal(isSlotTaken(error(409, 'SLOT_TAKEN')), true);
  assert.equal(isSlotTaken(error(409, 'INVALID_TRANSITION')), false);
});

test('semana começa na segunda; datas de calendário sem fuso; virada de mês e de ano', () => {
  assert.equal(isoWeekday('2026-11-09'), 1);
  assert.equal(weekStart('2026-11-15'), '2026-11-09'); // domingo
  assert.equal(weekStart('2026-11-09'), '2026-11-09');
  assert.equal(weekStart('2026-11-12'), '2026-11-09');
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  assert.deepEqual(weekDates('2026-11-09'), [
    '2026-11-09',
    '2026-11-10',
    '2026-11-11',
    '2026-11-12',
    '2026-11-13',
    '2026-11-14',
    '2026-11-15',
  ]);
  assert.equal(dayHeading('2026-11-10'), 'terça-feira, 10 de novembro');
  assert.equal(weekLabel('2026-11-09'), '9 a 15 de novembro');
  assert.equal(weekLabel('2026-10-26'), '26 de outubro a 1 de novembro');
  assert.equal(weekAnnouncement('2026-11-09', 3), '3 agendamentos de 9 a 15 de novembro');
  assert.equal(weekAnnouncement('2026-11-09', 1), '1 agendamento de 9 a 15 de novembro');
});

test('agrupa por localDate do servidor, na ordem recebida, um grupo por dia', () => {
  const items = [
    item({ id: '1', localDate: '2026-11-10', localStart: '09:00' }),
    item({ id: '2', localDate: '2026-11-10', localStart: '14:30' }),
    item({ id: '3', localDate: '2026-11-12', localStart: '10:00' }),
  ];
  const groups = groupByDay(items, weekDates('2026-11-09'));
  assert.equal(groups.length, 7);
  assert.deepEqual(
    groups[1]?.items.map((entry) => entry.id),
    ['1', '2'],
  );
  assert.deepEqual(
    groups[3]?.items.map((entry) => entry.id),
    ['3'],
  );
  assert.equal(groups[0]?.items.length, 0);
});

test('estados com texto (nunca só cor) e ações permitidas por estado', () => {
  assert.deepEqual(STATUS_LABELS, {
    PENDING: 'Pendente',
    CONFIRMED: 'Confirmado',
    CANCELLED: 'Cancelado',
    COMPLETED: 'Concluído',
    NO_SHOW: 'Faltou',
  });
  assert.equal(itemSummary(item()), '10:00 às 10:30 · Corte de cabelo · João · Confirmado');
  assert.equal(
    itemSummary(item({ kind: 'BLOCK', serviceId: null, serviceName: null })),
    '10:00 às 10:30 · Bloqueado',
  );
  assert.deepEqual(allowedActions(item({ status: 'PENDING' }), false), [
    'confirm',
    'reschedule',
    'cancel',
  ]);
  assert.deepEqual(allowedActions(item(), false), ['reschedule', 'cancel']);
  assert.deepEqual(allowedActions(item(), true), ['reschedule', 'cancel', 'complete', 'no_show']);
  for (const status of ['CANCELLED', 'COMPLETED', 'NO_SHOW'] as const) {
    assert.deepEqual(allowedActions(item({ status }), true), []);
  }
  assert.deepEqual(allowedActions(item({ kind: 'BLOCK' }), false), ['unblock']);
  assert.equal(
    hasStarted('2026-12-01T13:00:00.000Z', Date.parse('2026-12-01T13:00:00.000Z')),
    true,
  );
  assert.equal(
    hasStarted('2026-12-01T13:00:00.000Z', Date.parse('2026-12-01T12:59:59.000Z')),
    false,
  );
});

test('validação de formulários: nome de quem é atendido, serviço e horários da semana', () => {
  assert.equal(customerLabelProblem(''), null);
  assert.equal(customerLabelProblem('Maria'), null);
  assert.notEqual(customerLabelProblem('x'.repeat(61)), null);
  assert.notEqual(customerLabelProblem('a\nb'), null);
  assert.equal(serviceFormProblem({ name: 'Corte', duration: '30', buffer: '' }), null);
  assert.notEqual(serviceFormProblem({ name: 'Corte', duration: '33', buffer: '0' }), null);
  assert.notEqual(serviceFormProblem({ name: '', duration: '30', buffer: '0' }), null);
  assert.notEqual(serviceFormProblem({ name: 'Corte', duration: '30', buffer: '500' }), null);
  const w = (weekday: number, start: string, end: string) => ({ weekday, start, end });
  assert.equal(
    windowsProblem([w(1, '09:00', '12:00'), w(1, '14:00', '18:00'), w(2, '09:00', '12:00')]),
    null,
  );
  assert.notEqual(windowsProblem([w(1, '12:00', '09:00')]), null);
  assert.notEqual(windowsProblem([w(1, '09:00', '12:00'), w(1, '11:00', '13:00')]), null);
  assert.notEqual(windowsProblem([w(1, '09:00', '25:00')]), null);
});

test('aviso de bloqueio sobre agendamento compara só texto local (sem fuso) e ignora cancelados', () => {
  const items = [
    item({ localDate: '2026-12-01', localStart: '10:00', localEnd: '10:30' }),
    item({ id: '2', status: 'CANCELLED', localStart: '11:00', localEnd: '11:30' }),
    item({ id: '3', resourceId: OTHER_ID, localStart: '10:00', localEnd: '10:30' }),
  ];
  assert.equal(conflictingItems(items, [ID], '2026-12-01T09:00', '2026-12-01T12:00').length, 1);
  assert.equal(conflictingItems(items, [ID], '2026-12-01T10:30', '2026-12-01T12:00').length, 0);
  assert.equal(conflictingItems(items, [ID], '2026-12-02T09:00', '2026-12-02T12:00').length, 0);
});

test('o contrato do agendamento recusa contactRef e campo desconhecido', () => {
  assert.equal(appointmentSchema.safeParse(item()).success, true);
  assert.equal(
    appointmentSchema.safeParse({ ...item(), contactRef: '5511999990000' }).success,
    false,
  );
  assert.equal(appointmentSchema.safeParse({ ...item(), extra: 1 }).success, false);
});

test('o front não grava agendamento, nome nem horário em armazenamento do navegador, console ou URL', () => {
  for (const file of [
    'AgendaPage.tsx',
    'AgendaDialogs.tsx',
    'AgendaConfigPage.tsx',
    'agenda-api.ts',
    'agenda-rules.ts',
  ]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(
      source,
      /localStorage|sessionStorage|console\.|history\.(push|replace)State|document\.title/,
      file,
    );
  }
});

test('o navegador não calcula fuso: nada de getTimezoneOffset, timeZone do navegador ou conversão de instante', () => {
  for (const file of [
    'AgendaPage.tsx',
    'AgendaDialogs.tsx',
    'AgendaConfigPage.tsx',
    'agenda-rules.ts',
  ]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(
      source,
      /getTimezoneOffset|resolvedOptions|toLocaleTimeString|toLocaleString|getHours|getMinutes/,
      file,
    );
  }
});
