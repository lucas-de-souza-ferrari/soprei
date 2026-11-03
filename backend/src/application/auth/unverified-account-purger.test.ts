import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UnverifiedAccountPurgeRepository } from '../../domain/index.js';
import { startPurgeTimer, type PurgeScheduler } from './purge-timer.js';
import {
  PURGE_BATCH_SIZE,
  PURGE_MAX_BATCHES,
  UnverifiedAccountPurger,
  type PurgeRunSummary,
} from './unverified-account-purger.js';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const DAY = 24 * 60 * 60_000;

function fakeRepository(batches: (number | Error)[]) {
  const calls: { cutoff: Date; batchSize: number }[] = [];
  const repository: UnverifiedAccountPurgeRepository = {
    purgeUnverified: (cutoff, batchSize) => {
      calls.push({ cutoff, batchSize });
      const next = batches.shift() ?? 0;
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
  return { repository, calls };
}

test('o corte é a retenção em dias antes de agora e o lote é de 100', async () => {
  const { repository, calls } = fakeRepository([0]);
  const summaries: PurgeRunSummary[] = [];
  const purger = new UnverifiedAccountPurger({
    repository,
    retentionDays: 7,
    now: () => NOW,
    onRun: (summary) => summaries.push(summary),
  });
  const summary = await purger.runOnce();
  // Execução vazia: um lote só, nada apagado.
  assert.deepEqual(summary, { result: 'ok', purged: 0, batches: 1 });
  assert.deepEqual(summaries, [summary]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.batchSize, PURGE_BATCH_SIZE);
  assert.equal(calls[0].batchSize, 100);
  assert.equal(calls[0].cutoff.getTime(), NOW.getTime() - 7 * DAY);
});

test('repete lotes cheios até o teto de 10 lotes por execução e para no primeiro lote incompleto', async () => {
  const full = fakeRepository(Array.from({ length: 30 }, () => PURGE_BATCH_SIZE));
  const capped = await new UnverifiedAccountPurger({
    repository: full.repository,
    retentionDays: 1,
    now: () => NOW,
  }).runOnce();
  assert.equal(capped.batches, PURGE_MAX_BATCHES);
  assert.equal(capped.purged, PURGE_MAX_BATCHES * PURGE_BATCH_SIZE);
  assert.equal(full.calls.length, 10);

  const partial = fakeRepository([100, 100, 37, 100]);
  const stopped = await new UnverifiedAccountPurger({
    repository: partial.repository,
    retentionDays: 1,
    now: () => NOW,
  }).runOnce();
  assert.deepEqual(stopped, { result: 'ok', purged: 237, batches: 3 });
});

test('erro do repositório não derruba: vira resultado error só com contagens; observador que falha é engolido', async () => {
  const { repository } = fakeRepository([100, new Error('banco com segredo@example.test')]);
  const summaries: PurgeRunSummary[] = [];
  const purger = new UnverifiedAccountPurger({
    repository,
    retentionDays: 7,
    now: () => NOW,
    onRun: (summary) => {
      summaries.push(summary);
      throw new Error('observador quebrado');
    },
  });
  const summary = await purger.runOnce();
  assert.deepEqual(summary, { result: 'error', purged: 100, batches: 1 });
  assert.deepEqual(summaries, [summary]);
  assert.ok(!JSON.stringify(summary).includes('segredo'));
});

/** Agendador falso: guarda as chamadas e dispara os tiques sob comando (sem esperar tempo real). */
function fakeScheduler() {
  const handles: { unrefCalled: boolean; cleared: boolean; callback: () => void; ms: number }[] =
    [];
  const owners = new Map<NodeJS.Timeout, (typeof handles)[number]>();
  const make = (callback: () => void, ms: number): NodeJS.Timeout => {
    const record = { unrefCalled: false, cleared: false, callback, ms };
    handles.push(record);
    const timeout = {
      unref() {
        record.unrefCalled = true;
        return timeout;
      },
    } as unknown as NodeJS.Timeout;
    owners.set(timeout, record);
    return timeout;
  };
  const clear = (timeout: NodeJS.Timeout): void => {
    const record = owners.get(timeout);
    assert.ok(record);
    record.cleared = true;
  };
  const scheduler: PurgeScheduler = {
    setTimeout: make,
    setInterval: make,
    clearTimeout: clear,
    clearInterval: clear,
  };
  return { scheduler, handles };
}

test('timer: unref, primeira execução curta, intervalo configurado e nada agendado com 0', async () => {
  const none = fakeScheduler();
  assert.equal(
    startPurgeTimer({
      enabled: true,
      run: () => Promise.resolve(),
      intervalMinutes: 0,
      scheduler: none.scheduler,
    }),
    undefined,
  );
  assert.equal(none.handles.length, 0);
  // Sem contas globais (ACCOUNTS_ENABLED=false) nada é agendado, mesmo com intervalo positivo.
  const disabled = fakeScheduler();
  assert.equal(
    startPurgeTimer({
      enabled: false,
      run: () => Promise.resolve(),
      intervalMinutes: 60,
      scheduler: disabled.scheduler,
    }),
    undefined,
  );
  assert.equal(disabled.handles.length, 0);

  const { scheduler, handles } = fakeScheduler();
  let runs = 0;
  const timer = startPurgeTimer({
    enabled: true,
    run: () => {
      runs += 1;
      return Promise.resolve();
    },
    intervalMinutes: 60,
    scheduler,
  });
  assert.ok(timer);
  assert.equal(handles.length, 2);
  assert.ok(
    handles.every((handle) => handle.unrefCalled),
    'os dois timers são unref',
  );
  assert.equal(handles[0]?.ms, 30_000);
  assert.equal(handles[1]?.ms, 60 * 60_000);
  handles[0].callback();
  await timer.stop();
  assert.equal(runs, 1);
  assert.ok(handles.every((handle) => handle.cleared));
});

test('timer: um tique durante uma execução em curso é pulado e stop() espera a execução ativa', async () => {
  const { scheduler, handles } = fakeScheduler();
  let release: (() => void) | undefined;
  let started = 0;
  let finished = 0;
  const timer = startPurgeTimer({
    enabled: true,
    run: () => {
      started += 1;
      return new Promise<void>((resolve) => {
        release = () => {
          finished += 1;
          resolve();
        };
      });
    },
    intervalMinutes: 5,
    scheduler,
  });
  assert.ok(timer);
  const tick = handles[1]?.callback;
  assert.ok(tick);
  tick();
  tick();
  tick();
  assert.equal(started, 1, 'sem sobreposição');
  let stopped = false;
  const stopping = timer.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false, 'stop espera a execução ativa');
  release?.();
  await stopping;
  assert.equal(finished, 1);
  // Depois de parado, tiques atrasados não executam nada.
  tick();
  assert.equal(started, 1);
});

test('timer: com os timers reais do Node os dois ficam sem referência (não seguram o processo)', async () => {
  const created: NodeJS.Timeout[] = [];
  const timer = startPurgeTimer({
    enabled: true,
    run: () => Promise.resolve(),
    intervalMinutes: 1,
    scheduler: {
      setTimeout: (callback, ms) => {
        const handle = setTimeout(callback, ms);
        created.push(handle);
        return handle;
      },
      setInterval: (callback, ms) => {
        const handle = setInterval(callback, ms);
        created.push(handle);
        return handle;
      },
      clearTimeout: (handle) => {
        clearTimeout(handle);
      },
      clearInterval: (handle) => {
        clearInterval(handle);
      },
    },
  });
  assert.ok(timer);
  assert.equal(created.length, 2);
  for (const handle of created) assert.equal(handle.hasRef(), false);
  await timer.stop();
});
