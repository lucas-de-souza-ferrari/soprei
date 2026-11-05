import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addDays,
  daysBetween,
  formatLocalTime,
  isoWeekday,
  isValidLocalDate,
  isValidTimeZone,
  localPartsOf,
  parseLocalDateTime,
  zonedToInstant,
} from './zoned-time.js';

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

describe('zoned-time (spec 027)', () => {
  it('ida e volta local <-> UTC em quatro fusos', () => {
    const cases: [string, string, number, string][] = [
      ['America/Sao_Paulo', '2026-11-10', 14 * 60 + 30, '2026-11-10T17:30:00.000Z'],
      ['America/Manaus', '2026-11-10', 14 * 60 + 30, '2026-11-10T18:30:00.000Z'],
      ['America/New_York', '2026-07-10', 9 * 60, '2026-07-10T13:00:00.000Z'],
      ['America/New_York', '2026-12-10', 9 * 60, '2026-12-10T14:00:00.000Z'],
      ['Europe/Lisbon', '2026-07-10', 9 * 60, '2026-07-10T08:00:00.000Z'],
      ['Europe/Lisbon', '2026-12-10', 9 * 60, '2026-12-10T09:00:00.000Z'],
    ];
    for (const [zone, date, minute, expected] of cases) {
      const instant = zonedToInstant(date, minute, zone);
      assert.equal(iso(instant), expected, `${zone} ${date}`);
      assert.ok(instant !== null);
      const back = localPartsOf(instant, zone);
      assert.equal(back.date, date);
      assert.equal(back.minute, minute);
    }
  });

  it('lacuna do horário de verão (2026-03-08 02:30 em Nova York) não tem instante', () => {
    assert.equal(zonedToInstant('2026-03-08', 2 * 60 + 30, 'America/New_York'), null);
    // Antes e depois da lacuna existem.
    assert.equal(
      iso(zonedToInstant('2026-03-08', 60 + 30, 'America/New_York')),
      '2026-03-08T06:30:00.000Z',
    );
    assert.equal(
      iso(zonedToInstant('2026-03-08', 3 * 60, 'America/New_York')),
      '2026-03-08T07:00:00.000Z',
    );
    assert.equal(parseLocalDateTime('2026-03-08T02:30', 'America/New_York'), null);
  });

  it('repetição (2026-11-01 01:30 em Nova York) usa a primeira ocorrência', () => {
    // 01:30 EDT (UTC-4) = 05:30Z; a segunda ocorrência (EST) seria 06:30Z.
    assert.equal(
      iso(zonedToInstant('2026-11-01', 60 + 30, 'America/New_York')),
      '2026-11-01T05:30:00.000Z',
    );
  });

  it('virada de dia: 23:30 em São Paulo é o dia seguinte em UTC, mas a data local fica', () => {
    const instant = zonedToInstant('2026-11-10', 23 * 60 + 30, 'America/Sao_Paulo');
    assert.equal(iso(instant), '2026-11-11T02:30:00.000Z');
    assert.ok(instant !== null);
    assert.deepEqual(localPartsOf(instant, 'America/Sao_Paulo'), {
      date: '2026-11-10',
      minute: 23 * 60 + 30,
      weekday: 2,
    });
    assert.equal(formatLocalTime(instant, 'America/Sao_Paulo'), '23:30');
  });

  it('aritmética de calendário: virada de mês e de ano, ano bissexto', () => {
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(addDays('2028-02-28', 1), '2028-02-29');
    assert.equal(addDays('2028-02-29', 1), '2028-03-01');
    assert.equal(daysBetween('2026-11-01', '2026-11-15'), 14);
    assert.equal(isValidLocalDate('2028-02-29'), true);
    assert.equal(isValidLocalDate('2026-02-29'), false);
    assert.equal(isValidLocalDate('2026-13-01'), false);
    assert.equal(isoWeekday('2026-11-09'), 1); // segunda
    assert.equal(isoWeekday('2026-11-15'), 7); // domingo
  });

  it('fuso inválido é recusado; fuso válido, aceito', () => {
    assert.equal(isValidTimeZone('America/Sao_Paulo'), true);
    assert.equal(isValidTimeZone('UTC'), true);
    assert.equal(isValidTimeZone('Mars/Olympus'), false);
    assert.equal(isValidTimeZone(''), false);
    assert.equal(isValidTimeZone('x'.repeat(65)), false);
  });

  it('parseLocalDateTime recusa formato e valores impossíveis', () => {
    assert.equal(parseLocalDateTime('2026-11-10 14:30', 'America/Sao_Paulo'), null);
    assert.equal(parseLocalDateTime('2026-11-10T24:00', 'America/Sao_Paulo'), null);
    assert.equal(parseLocalDateTime('2026-02-30T10:00', 'America/Sao_Paulo'), null);
    assert.equal(
      iso(parseLocalDateTime('2026-11-10T14:30', 'America/Sao_Paulo')),
      '2026-11-10T17:30:00.000Z',
    );
  });
});
