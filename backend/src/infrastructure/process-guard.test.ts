import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it } from 'node:test';
import { ConflictError } from '../shared/errors/index.js';
import { createMetrics } from './metrics/index.js';
import { describeFatalError, installProcessGuard } from './process-guard.js';

const SECRET = 'texto-secreto-do-contato-guard-91';

interface LogEntry {
  readonly level: 'info' | 'error' | 'fatal';
  readonly fields: object;
  readonly message: string;
}

function setup(options: { shutdown?: () => Promise<void>; timeoutMs?: number } = {}) {
  const target = new EventEmitter();
  const logs: LogEntry[] = [];
  const exits: number[] = [];
  let shutdowns = 0;
  const metrics = createMetrics();
  const record =
    (level: LogEntry['level']) =>
    (fields: object, message: string): void => {
      logs.push({ level, fields, message });
    };
  const guard = installProcessGuard({
    target,
    logger: { info: record('info'), error: record('error'), fatal: record('fatal') },
    shutdown: () => {
      shutdowns += 1;
      return (options.shutdown ?? (() => Promise.resolve()))();
    },
    timeoutMs: options.timeoutMs ?? 5_000,
    exit: (code) => {
      exits.push(code);
    },
    metrics,
  });
  return { target, logs, exits, metrics, guard, shutdowns: () => shutdowns };
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(5);
  }
  throw new Error(`tempo esgotado esperando: ${label}`);
}

describe('guarda do processo (spec 034)', () => {
  it('SIGTERM desliga uma vez e sai com código 0', async () => {
    const h = setup();
    h.target.emit('SIGTERM');
    await waitFor(() => h.exits.length === 1, 'saída');
    assert.deepEqual(h.exits, [0]);
    assert.equal(h.shutdowns(), 1);
  });

  it('dois SIGTERM seguidos (e um SIGINT) executam o desligamento uma vez só', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = setup({ shutdown: () => gate });
    h.target.emit('SIGTERM');
    h.target.emit('SIGTERM');
    h.target.emit('SIGINT');
    assert.equal(h.shutdowns(), 1);
    assert.deepEqual(h.exits, []);
    release();
    await waitFor(() => h.exits.length === 1, 'saída');
    assert.deepEqual(h.exits, [0]);
    assert.equal(h.shutdowns(), 1);
  });

  it('rejeição não tratada: log fatal sem a mensagem do erro, métrica, desligamento e saída 1', async () => {
    const h = setup();
    h.target.emit('unhandledRejection', new Error(SECRET));
    await waitFor(() => h.exits.length === 1, 'saída');
    assert.deepEqual(h.exits, [1]);
    assert.equal(h.shutdowns(), 1);
    const fatal = h.logs.filter((entry) => entry.level === 'fatal');
    assert.equal(fatal.length, 1);
    assert.deepEqual(
      { kind: 'unhandled_rejection', errName: 'Error' },
      {
        kind: (fatal[0]?.fields as { kind?: string }).kind,
        errName: (fatal[0]?.fields as { errName?: string }).errName,
      },
    );
    // Nem a mensagem do erro nem o objeto inteiro aparecem em log algum.
    assert.doesNotMatch(JSON.stringify(h.logs), new RegExp(SECRET));
    assert.match(
      await h.metrics.render(),
      /process_fatal_errors_total\{kind="unhandled_rejection"\} 1/,
    );
  });

  it('exceção não capturada: o mesmo tratamento, com o seu rótulo', async () => {
    const h = setup();
    h.target.emit('uncaughtException', new TypeError(SECRET));
    await waitFor(() => h.exits.length === 1, 'saída');
    assert.deepEqual(h.exits, [1]);
    assert.equal(h.shutdowns(), 1);
    assert.doesNotMatch(JSON.stringify(h.logs), new RegExp(SECRET));
    assert.match(
      await h.metrics.render(),
      /process_fatal_errors_total\{kind="uncaught_exception"\} 1/,
    );
  });

  it('rejeição com valor que não é erro (string) não vaza o valor', async () => {
    const h = setup();
    h.target.emit('unhandledRejection', SECRET);
    await waitFor(() => h.exits.length === 1, 'saída');
    assert.deepEqual(h.exits, [1]);
    assert.doesNotMatch(JSON.stringify(h.logs), new RegExp(SECRET));
  });

  it('erro fatal durante o desligamento encerra na hora, com código 1', async () => {
    const h = setup({ shutdown: () => new Promise<void>(() => undefined) });
    h.target.emit('SIGTERM');
    assert.deepEqual(h.exits, []);
    h.target.emit('uncaughtException', new Error('durante o desligamento'));
    assert.deepEqual(h.exits, [1]);
    assert.equal(h.shutdowns(), 1);
    await Promise.resolve();
  });

  it('desligamento que não termina no prazo sai com código 1 e log de erro', async () => {
    const h = setup({ shutdown: () => new Promise<void>(() => undefined), timeoutMs: 40 });
    h.target.emit('SIGTERM');
    await waitFor(() => h.exits.length === 1, 'saída pelo prazo');
    assert.deepEqual(h.exits, [1]);
    assert.ok(
      h.logs.some((entry) => entry.level === 'error' && /prazo/.test(entry.message)),
      'log de erro do prazo',
    );
  });

  it('desligamento que falha sai com código 1, sem a mensagem do erro no log', async () => {
    const h = setup({ shutdown: () => Promise.reject(new Error(SECRET)) });
    h.target.emit('SIGINT');
    await waitFor(() => h.exits.length === 1, 'saída');
    assert.deepEqual(h.exits, [1]);
    assert.doesNotMatch(JSON.stringify(h.logs), new RegExp(SECRET));
  });

  it('depois de sair, o prazo vencido não chama a saída de novo', async () => {
    const h = setup({ timeoutMs: 30 });
    h.target.emit('SIGTERM');
    await waitFor(() => h.exits.length === 1, 'saída');
    await sleep(80);
    assert.deepEqual(h.exits, [0]);
  });
});

describe('describeFatalError', () => {
  it('leva o tipo, o code de um BaseError e só os quadros da pilha', () => {
    const described = describeFatalError(new ConflictError(SECRET, { code: 'LAST_OWNER' }));
    assert.equal(described.errName, 'ConflictError');
    assert.equal(described.errCode, 'LAST_OWNER');
    assert.ok((described.stack ?? []).every((line) => line.startsWith('at ')));
    assert.doesNotMatch(JSON.stringify(described), new RegExp(SECRET));
  });

  it('valor que não é erro vira só o tipo', () => {
    assert.deepEqual(describeFatalError({ secret: SECRET }), { errName: 'object' });
    assert.deepEqual(describeFatalError(undefined), { errName: 'undefined' });
  });
});
