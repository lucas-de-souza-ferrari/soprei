import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeSlots, type ComputeSlotsInput } from './availability.js';
import { zonedToInstant } from './zoned-time.js';

const ZONE = 'America/Sao_Paulo';
// Segunda-feira 2026-11-09, 08:00 em São Paulo (11:00Z).
const NOW = new Date('2026-11-09T11:00:00.000Z');

const at = (date: string, hhmm: string, zone = ZONE): Date => {
  const [h, m] = hhmm.split(':').map(Number);
  const instant = zonedToInstant(date, (h ?? 0) * 60 + (m ?? 0), zone);
  assert.ok(instant !== null);
  return instant;
};

const base = (overrides: Partial<ComputeSlotsInput> = {}): ComputeSlotsInput => ({
  timezone: ZONE,
  slotStepMinutes: 30,
  minNoticeMinutes: 0,
  maxAdvanceDays: 60,
  service: { durationMinutes: 60, bufferMinutes: 0 },
  resources: [{ id: 'r1', windows: [{ weekday: 2, startMinute: 9 * 60, endMinute: 12 * 60 }] }],
  busy: [],
  now: NOW,
  fromDate: '2026-11-10',
  toDate: '2026-11-10',
  ...overrides,
});

const starts = (input: ComputeSlotsInput): string[] =>
  computeSlots(input).map((slot) => slot.localStart);

describe('computeSlots (spec 027)', () => {
  it('janela 9h-12h com serviço de 60 min e passo 30 gera 9:00 a 11:00 (não 11:30)', () => {
    assert.deepEqual(starts(base()), ['09:00', '09:30', '10:00', '10:30', '11:00']);
  });

  it('devolve os campos locais e o fim pela duração', () => {
    const [first] = computeSlots(base());
    assert.equal(first?.localDate, '2026-11-10');
    assert.equal(first.localEnd, '10:00');
    assert.equal(first.startsAt.toISOString(), '2026-11-10T12:00:00.000Z');
  });

  it('várias janelas no mesmo dia (almoço) e dia sem regra vazio', () => {
    const resources = [
      {
        id: 'r1',
        windows: [
          { weekday: 2, startMinute: 9 * 60, endMinute: 11 * 60 },
          { weekday: 2, startMinute: 14 * 60, endMinute: 16 * 60 },
        ],
      },
    ];
    assert.deepEqual(starts(base({ resources })), [
      '09:00',
      '09:30',
      '10:00',
      '14:00',
      '14:30',
      '15:00',
    ]);
    assert.deepEqual(starts(base({ resources, fromDate: '2026-11-11', toDate: '2026-11-11' })), []);
  });

  it('serviço que não cabe na janela não gera horário', () => {
    assert.deepEqual(starts(base({ service: { durationMinutes: 240, bufferMinutes: 0 } })), []);
  });

  it('antecedência mínima: "daqui a 30 min" some com mínimo de 120', () => {
    const now = at('2026-11-10', '08:30'); // 30 min antes das 09:00
    const input = base({ now, minNoticeMinutes: 120 });
    // Mínimo de 120 min: o primeiro horário é 10:30.
    assert.deepEqual(starts(input), ['10:30', '11:00']);
    assert.deepEqual(starts({ ...input, minNoticeMinutes: 0 }).slice(0, 2), ['09:00', '09:30']);
  });

  it('teto de dias: nada além de now + maxAdvanceDays', () => {
    const input = base({ maxAdvanceDays: 1, fromDate: '2026-11-10', toDate: '2026-11-10' });
    // now = segunda 08:00; +1 dia = terça 08:00; 9:00 da terça passa do teto.
    assert.deepEqual(starts(input), []);
    assert.equal(starts({ ...input, maxAdvanceDays: 2 }).length, 5);
  });

  it('passo diferente muda os candidatos', () => {
    assert.deepEqual(starts(base({ slotStepMinutes: 60 })), ['09:00', '10:00', '11:00']);
    assert.deepEqual(
      starts(
        base({ slotStepMinutes: 20, service: { durationMinutes: 40, bufferMinutes: 0 } }),
      ).slice(0, 4),
      ['09:00', '09:20', '09:40', '10:00'],
    );
  });

  it('agendamento ativo e bloqueio tiram os horários que colidem; cancelado nem chega aqui', () => {
    const busy = [
      {
        resourceId: 'r1',
        startsAt: at('2026-11-10', '09:30'),
        blockedUntil: at('2026-11-10', '10:30'),
      },
    ];
    // 09:00 (ocupa 09:00-10:00) colide com 09:30-10:30; 10:30 já passa (limite semiaberto).
    assert.deepEqual(starts(base({ busy })), ['10:30', '11:00']);
  });

  it('buffer do serviço novo conta contra o que vem depois; o do existente já está no blockedUntil', () => {
    const busy = [
      {
        resourceId: 'r1',
        startsAt: at('2026-11-10', '10:00'),
        blockedUntil: at('2026-11-10', '10:30'),
      },
    ];
    const thirty = { durationMinutes: 30, bufferMinutes: 0 };
    assert.deepEqual(starts(base({ busy, service: thirty })), [
      '09:00',
      '09:30',
      '10:30',
      '11:00',
      '11:30',
    ]);
    // Com 10 min de intervalo, 09:30 (ocupa até 10:10) colide com o item das 10:00.
    const withBuffer = { durationMinutes: 30, bufferMinutes: 10 };
    assert.deepEqual(starts(base({ busy, service: withBuffer })), [
      '09:00',
      '10:30',
      '11:00',
      '11:30',
    ]);
  });

  it('item de outro recurso não bloqueia', () => {
    const busy = [
      {
        resourceId: 'r2',
        startsAt: at('2026-11-10', '09:00'),
        blockedUntil: at('2026-11-10', '12:00'),
      },
    ];
    assert.equal(starts(base({ busy })).length, 5);
  });

  it('vários recursos: ordenados por horário e, no empate, pela ordem recebida', () => {
    const windows = [{ weekday: 2, startMinute: 9 * 60, endMinute: 10 * 60 }];
    const slots = computeSlots(
      base({
        resources: [
          { id: 'b', windows },
          { id: 'a', windows },
        ],
        service: { durationMinutes: 60, bufferMinutes: 0 },
      }),
    );
    assert.deepEqual(
      slots.map((slot) => slot.resourceId),
      ['b', 'a'],
    );
  });

  it('o mesmo "9h-12h" dá instantes UTC diferentes em fusos diferentes', () => {
    const [sp] = computeSlots(base());
    const [ny] = computeSlots(
      base({ timezone: 'America/New_York', now: new Date('2026-11-09T00:00:00.000Z') }),
    );
    assert.ok(sp !== undefined && ny !== undefined);
    assert.equal(sp.localStart, '09:00');
    assert.equal(ny.localStart, '09:00');
    assert.notEqual(sp.startsAt.getTime(), ny.startsAt.getTime());
    assert.equal(ny.startsAt.toISOString(), '2026-11-10T14:00:00.000Z');
  });

  it('lacuna do horário de verão não gera candidato (Nova York, 2026-03-08, janela 1h às 4h)', () => {
    const slots = computeSlots(
      base({
        timezone: 'America/New_York',
        now: new Date('2026-03-01T00:00:00.000Z'),
        fromDate: '2026-03-08',
        toDate: '2026-03-08',
        service: { durationMinutes: 30, bufferMinutes: 0 },
        resources: [{ id: 'r1', windows: [{ weekday: 7, startMinute: 60, endMinute: 4 * 60 }] }],
      }),
    );
    assert.deepEqual(
      slots.map((slot) => slot.localStart),
      ['01:00', '01:30', '03:00', '03:30'],
    );
  });

  it('intervalo de vários dias (14) devolve em ordem cronológica', () => {
    const resources = [
      {
        id: 'r1',
        windows: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 600, endMinute: 660 })),
      },
    ];
    const slots = computeSlots(
      base({
        resources,
        fromDate: '2026-11-10',
        toDate: '2026-11-23',
        service: { durationMinutes: 60, bufferMinutes: 0 },
      }),
    );
    assert.equal(slots.length, 10);
    assert.deepEqual(
      slots.map((slot) => slot.startsAt.getTime()),
      [...slots.map((slot) => slot.startsAt.getTime())].sort((a, b) => a - b),
    );
  });
});
