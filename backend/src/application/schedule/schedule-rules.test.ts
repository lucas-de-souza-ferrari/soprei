import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canTransition, isActiveStatus } from '../../domain/index.js';
import { ValidationError } from '../../shared/errors/index.js';
import { rulesBodySchema, serviceInputSchema } from './schedule.schemas.js';
import { validateWindows } from './schedule.service.js';

describe('regras da agenda (spec 027)', () => {
  it('transições permitidas: só ativos mudam e terminais ficam', () => {
    assert.equal(canTransition('PENDING', 'CONFIRMED'), true);
    assert.equal(canTransition('PENDING', 'CANCELLED'), true);
    assert.equal(canTransition('PENDING', 'COMPLETED'), false);
    assert.equal(canTransition('CONFIRMED', 'CANCELLED'), true);
    assert.equal(canTransition('CONFIRMED', 'COMPLETED'), true);
    assert.equal(canTransition('CONFIRMED', 'NO_SHOW'), true);
    for (const terminal of ['CANCELLED', 'COMPLETED', 'NO_SHOW'] as const) {
      assert.equal(isActiveStatus(terminal), false);
      for (const target of ['PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW'] as const) {
        assert.equal(canTransition(terminal, target), false);
      }
    }
  });

  it('janelas: sobreposição e excesso no mesmo dia são recusados; adjacentes e dias diferentes passam', () => {
    const w = (weekday: number, startMinute: number, endMinute: number) => ({
      weekday,
      startMinute,
      endMinute,
    });
    validateWindows([w(1, 540, 720), w(1, 720, 900), w(2, 540, 720)]);
    assert.throws(
      () => {
        validateWindows([w(1, 540, 720), w(1, 700, 900)]);
      },
      (error: unknown) => error instanceof ValidationError && error.code === 'INVALID_WINDOWS',
    );
    const seven = Array.from({ length: 7 }, (_, index) => w(3, index * 60, index * 60 + 30));
    assert.throws(() => {
      validateWindows(seven);
    }, ValidationError);
  });

  it('esquemas: HH:mm vira minutos, 24:00 só como fim, duração múltipla de 5', () => {
    const parsed = rulesBodySchema.parse({
      windows: [{ weekday: 7, start: '00:00', end: '24:00' }],
    });
    assert.deepEqual(parsed.windows, [{ weekday: 7, start: 0, end: 1440 }]);
    assert.equal(
      rulesBodySchema.safeParse({ windows: [{ weekday: 1, start: '24:00', end: '24:00' }] })
        .success,
      false,
    );
    assert.equal(serviceInputSchema.safeParse({ name: 'x', durationMinutes: 35 }).success, true);
    assert.equal(serviceInputSchema.safeParse({ name: 'x', durationMinutes: 33 }).success, false);
    assert.equal(serviceInputSchema.parse({ name: 'x', durationMinutes: 30 }).bufferMinutes, 0);
  });
});
