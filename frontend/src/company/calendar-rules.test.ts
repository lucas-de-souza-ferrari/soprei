import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Appointment } from './agenda-api';
import { daysBetween, isoWeekday } from './agenda-rules';
import {
  addMonths,
  blockPosition,
  itemAccessibleName,
  monthAnnouncement,
  monthCells,
  monthGrid,
  monthLabel,
  monthRange,
  monthStart,
  startAtOffset,
  visibleRange,
  weekBlocks,
} from './calendar-rules';

let counter = 0;
function item(
  localDate: string,
  localStart: string,
  localEnd: string,
  extra: Partial<Appointment> = {},
): Appointment {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    kind: 'BOOKING',
    status: 'CONFIRMED',
    source: 'PANEL',
    resourceId: '00000000-0000-4000-8000-0000000000aa',
    resourceName: 'Agenda principal',
    serviceId: '00000000-0000-4000-8000-0000000000bb',
    serviceName: 'Corte de cabelo',
    startsAt: '2026-11-10T12:00:00.000Z',
    endsAt: '2026-11-10T12:30:00.000Z',
    localDate,
    localStart,
    localEnd,
    weekday: isoWeekday(localDate),
    customerLabel: 'Maria',
    contactLabel: null,
    createdAt: '2026-11-09T11:00:00.000Z',
    ...extra,
  } as Appointment;
}

const WEEK = [
  '2026-11-09',
  '2026-11-10',
  '2026-11-11',
  '2026-11-12',
  '2026-11-13',
  '2026-11-14',
  '2026-11-15',
];

test('spec 029 E4: a grade do mês tem 42 dias, começa na segunda e é contínua (28, 30 e 31 dias, bissexto, virada)', () => {
  for (const anchor of [
    '2026-02-15',
    '2026-11-10',
    '2026-12-31',
    '2028-02-29',
    '2027-01-01',
    '2026-03-01',
    '2026-06-30',
  ]) {
    const grid = monthGrid(anchor);
    assert.equal(grid.length, 42, anchor);
    assert.equal(isoWeekday(grid[0] ?? ''), 1, `${anchor}: começa na segunda`);
    for (let index = 1; index < grid.length; index++)
      assert.equal(daysBetween(grid[index - 1] ?? '', grid[index] ?? ''), 1);
    // Todo dia do mês aparece na grade.
    const first = monthStart(anchor);
    assert.ok(grid.includes(first), `${anchor}: contém o dia 1`);
    const range = monthRange(anchor);
    assert.equal(daysBetween(range.from, range.to) + 1, 42);
    assert.ok(daysBetween(range.from, range.to) + 1 <= 42);
  }
  assert.equal(monthGrid('2026-02-10')[0], '2026-01-26');
  assert.equal(monthGrid('2028-02-10')[0], '2028-01-31');
  assert.equal(monthGrid('2027-01-10')[0], '2026-12-28');
  // Mês de 28 dias que começa na segunda: a grade tem 14 dias do mês seguinte.
  assert.equal(monthGrid('2027-02-01')[0], '2027-02-01');
});

test('spec 029 E4: addMonths e rótulos atravessam o ano', () => {
  assert.equal(addMonths('2026-12-15', 1), '2027-01-01');
  assert.equal(addMonths('2027-01-31', -1), '2026-12-01');
  assert.equal(addMonths('2026-11-10', 14), '2028-01-01');
  assert.equal(monthLabel('2026-11-10'), 'novembro de 2026');
  assert.equal(monthAnnouncement('2026-11-01', 1), '1 agendamento em novembro de 2026');
  assert.equal(monthAnnouncement('2026-11-01', 3), '3 agendamentos em novembro de 2026');
});

test('spec 029 E4: o bloco é posicionado pelos minutos de localStart e localEnd (passos de 15 min)', () => {
  const blocks = weekBlocks([item('2026-11-10', '09:00', '10:00')], WEEK).get('2026-11-10') ?? [];
  assert.equal(blocks.length, 1);
  const range = visibleRange(blocks);
  assert.deepEqual(range, { start: 420, end: 1200 });
  const position = blockPosition(blocks[0] as (typeof blocks)[number], range);
  assert.ok(Math.abs(position.top - (120 / 780) * 100) < 1e-9);
  assert.ok(Math.abs(position.height - (60 / 780) * 100) < 1e-9);
  // Arredonda o desenho ao passo de 15 minutos (09:07 desenha às 09:00).
  const odd = weekBlocks([item('2026-11-10', '09:07', '09:38')], WEEK).get('2026-11-10') ?? [];
  const oddPos = blockPosition(odd[0] as (typeof odd)[number], range);
  assert.ok(Math.abs(oddPos.top - (120 / 780) * 100) < 1e-9);
});

test('spec 029 E4: item às 06:10 e às 23:30 amplia o intervalo visível, nunca esconde item', () => {
  const early = weekBlocks([item('2026-11-10', '06:10', '06:40')], WEEK);
  assert.deepEqual(visibleRange([...early.values()].flat()), { start: 360, end: 1200 });
  const late = weekBlocks([item('2026-11-10', '23:30', '23:50')], WEEK);
  assert.deepEqual(visibleRange([...late.values()].flat()), { start: 420, end: 1440 });
  const both = weekBlocks(
    [item('2026-11-10', '07:00', '07:30'), item('2026-11-11', '23:30', '23:45')],
    WEEK,
  );
  assert.deepEqual(visibleRange([...both.values()].flat()), { start: 420, end: 1440 });
  assert.deepEqual(visibleRange([]), { start: 420, end: 1200 });
});

test('spec 029 E4: item que atravessa a meia-noite é cortado no dia e continua no seguinte', () => {
  const byDay = weekBlocks([item('2026-11-14', '22:00', '01:00')], WEEK);
  const saturday = byDay.get('2026-11-14') ?? [];
  const sunday = byDay.get('2026-11-15') ?? [];
  assert.equal(saturday.length, 1);
  assert.equal(saturday[0]?.endMin, 1440);
  assert.equal(saturday[0]?.continuesToNext, true);
  assert.equal(sunday.length, 1);
  assert.equal(sunday[0]?.startMin, 0);
  assert.equal(sunday[0]?.endMin, 60);
  assert.equal(sunday[0]?.continuesFromPrevious, true);
  // No último dia da semana a continuação cai na semana seguinte: só o corte do dia aparece.
  const edge = weekBlocks([item('2026-11-15', '23:00', '00:30')], WEEK);
  assert.equal((edge.get('2026-11-15') ?? []).length, 1);
});

test('spec 029 E4: itens sobrepostos ficam lado a lado e os separados usam a coluna inteira', () => {
  const day = '2026-11-10';
  const byDay = weekBlocks(
    [
      item(day, '09:00', '10:00'),
      item(day, '09:30', '10:30'),
      item(day, '09:45', '10:15'),
      item(day, '11:00', '11:30'),
    ],
    WEEK,
  );
  const blocks = byDay.get(day) ?? [];
  const at = (start: number) => blocks.find((block) => block.startMin === start);
  assert.equal(at(540)?.columns, 3);
  assert.equal(at(570)?.columns, 3);
  assert.equal(at(585)?.columns, 3);
  assert.deepEqual([at(540)?.column, at(570)?.column, at(585)?.column].sort(), [0, 1, 2]);
  assert.equal(at(660)?.columns, 1);
  assert.equal(at(660)?.column, 0);
});

test('spec 029 E4: clique na faixa vira localStart no passo de 15 minutos, dentro do intervalo', () => {
  const range = { start: 420, end: 1200 };
  assert.equal(startAtOffset('2026-11-10', range, 0), '2026-11-10T07:00');
  assert.equal(startAtOffset('2026-11-10', range, 0.5), '2026-11-10T13:30');
  assert.equal(startAtOffset('2026-11-10', range, 5), '2026-11-10T19:45');
  assert.equal(startAtOffset('2026-11-10', range, -3), '2026-11-10T07:00');
});

test('spec 029 E4: o mês mostra até 3 itens por dia e o "+N" do resto, agrupando por localDate', () => {
  const items = [
    item('2026-11-10', '08:00', '08:30'),
    item('2026-11-10', '09:00', '09:30'),
    item('2026-11-10', '10:00', '10:30'),
    item('2026-11-10', '11:00', '11:30'),
    item('2026-11-10', '12:00', '12:30'),
    item('2026-11-11', '08:00', '08:30'),
  ];
  const cells = monthCells(items, '2026-11-01');
  assert.equal(cells.length, 42);
  const tenth = cells.find((cell) => cell.date === '2026-11-10');
  assert.equal(tenth?.shown.length, 3);
  assert.equal(tenth?.extra, 2);
  assert.equal(tenth?.total, 5);
  assert.equal(cells.find((cell) => cell.date === '2026-11-11')?.extra, 0);
  assert.equal(cells.find((cell) => cell.date === '2026-10-26')?.inMonth, false);
  assert.equal(cells.find((cell) => cell.date === '2026-11-01')?.inMonth, true);
});

test('spec 029 E4: nome acessível completo com dia, hora, serviço, atendido e estado', () => {
  const name = itemAccessibleName(item('2026-11-12', '09:00', '09:30'));
  assert.equal(
    name,
    'quinta-feira, 12 de novembro, 09:00 às 09:30, Corte de cabelo, Maria, Confirmado',
  );
  const block = itemAccessibleName(
    item('2026-11-12', '09:00', '10:00', { kind: 'BLOCK', serviceName: null, customerLabel: null }),
  );
  assert.equal(block, 'quinta-feira, 12 de novembro, 09:00 às 10:00, Bloqueado');
});

test('spec 029 E4: o resultado não depende do fuso do navegador (TZ diferentes dão o mesmo)', () => {
  const original = process.env['TZ'];
  const snapshot = () =>
    JSON.stringify({
      grid: monthGrid('2026-11-10'),
      range: monthRange('2026-03-31'),
      cells: monthCells([item('2026-11-10', '09:00', '09:30')], '2026-11-01').map((cell) => [
        cell.date,
        cell.total,
      ]),
      blocks: [
        ...weekBlocks(
          [item('2026-11-14', '22:00', '01:00'), item('2026-11-10', '09:00', '10:00')],
          WEEK,
        ),
      ].map(([date, list]) => [
        date,
        list.map((block) => [block.startMin, block.endMin, block.column]),
      ]),
      months: [addMonths('2026-10-31', 1), monthLabel('2026-12-01')],
    });
  try {
    process.env['TZ'] = 'UTC';
    const baseline = snapshot();
    for (const zone of [
      'Pacific/Kiritimati',
      'America/Sao_Paulo',
      'Pacific/Pago_Pago',
      'Europe/Lisbon',
    ]) {
      process.env['TZ'] = zone;
      assert.equal(snapshot(), baseline, zone);
    }
  } finally {
    if (original === undefined) delete process.env['TZ'];
    else process.env['TZ'] = original;
  }
});

test('spec 029 E4: o código novo do calendário não converte fuso nem usa a hora local do navegador', () => {
  const forbidden =
    /new Date\(|Date\.now\(|getHours|getMinutes|getDate\(|getDay\(|getMonth\(|getFullYear|getTimezoneOffset|toLocale|Intl\.DateTimeFormat|\bDate\.parse\(/;
  for (const file of ['calendar-rules.ts', 'AgendaCalendar.tsx']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      // Comentários explicam a regra e podem citar os nomes.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(source, forbidden, file);
  }
});
