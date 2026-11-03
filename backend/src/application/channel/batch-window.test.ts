import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { flushDelayMs } from './batch-window.js';

const at = (ms: number): Date => new Date(Date.UTC(2026, 0, 1) + ms);

describe('flushDelayMs: janela deslizante com teto', () => {
  it('mensagem isolada espera a janela inteira', () => {
    const delay = flushDelayMs({
      windowMs: 5_000,
      maxWaitMs: 20_000,
      oldestPendingAt: at(0),
      referenceAt: at(0),
    });
    assert.equal(delay, 5_000);
  });

  it('cada mensagem nova reinicia a janela inteira enquanto o teto não aperta', () => {
    // A primeira há 3 s; a nova reinicia a espera de 5 s (3 + 5 = 8 s < 20 s).
    assert.equal(
      flushDelayMs({
        windowMs: 5_000,
        maxWaitMs: 20_000,
        oldestPendingAt: at(0),
        referenceAt: at(3_000),
      }),
      5_000,
    );
  });

  it('o teto encurta a espera: nunca passa de maxWait desde a mais antiga pendente', () => {
    // Pendente desde 17 s: faltam 3 s para o teto de 20 s, menos que a janela de 5 s.
    assert.equal(
      flushDelayMs({
        windowMs: 5_000,
        maxWaitMs: 20_000,
        oldestPendingAt: at(0),
        referenceAt: at(17_000),
      }),
      3_000,
    );
  });

  it('teto já vencido (ou ultrapassado) vira espera zero, nunca negativa', () => {
    for (const waited of [20_000, 25_000, 600_000]) {
      assert.equal(
        flushDelayMs({
          windowMs: 5_000,
          maxWaitMs: 20_000,
          oldestPendingAt: at(0),
          referenceAt: at(waited),
        }),
        0,
      );
    }
  });

  it('janela zero desliga a espera, mesmo com teto folgado', () => {
    assert.equal(
      flushDelayMs({
        windowMs: 0,
        maxWaitMs: 20_000,
        oldestPendingAt: at(0),
        referenceAt: at(100),
      }),
      0,
    );
  });

  it('sem pendente conhecida, usa a janela; referência anterior à pendente não dá espera maior que a janela', () => {
    assert.equal(
      flushDelayMs({
        windowMs: 5_000,
        maxWaitMs: 20_000,
        oldestPendingAt: null,
        referenceAt: at(0),
      }),
      5_000,
    );
    assert.equal(
      flushDelayMs({
        windowMs: 5_000,
        maxWaitMs: 20_000,
        oldestPendingAt: at(1_000),
        referenceAt: at(0),
      }),
      5_000,
    );
  });

  it('teto igual à janela: a primeira espera a janela e a seguinte já cai no teto', () => {
    assert.equal(
      flushDelayMs({
        windowMs: 5_000,
        maxWaitMs: 5_000,
        oldestPendingAt: at(0),
        referenceAt: at(0),
      }),
      5_000,
    );
    assert.equal(
      flushDelayMs({
        windowMs: 5_000,
        maxWaitMs: 5_000,
        oldestPendingAt: at(0),
        referenceAt: at(2_000),
      }),
      3_000,
    );
  });
});
