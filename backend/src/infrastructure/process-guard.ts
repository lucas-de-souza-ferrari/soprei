import { BaseError } from '../shared/errors/index.js';

/** Erro fatal do processo (label `kind` de `process_fatal_errors_total`; conjunto fixo). */
export type ProcessFatalKind = 'unhandled_rejection' | 'uncaught_exception';

/** O que a guarda precisa do `process` (os testes passam um emissor falso). */
export interface ProcessLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface ProcessGuardLogger {
  info(fields: object, message: string): void;
  error(fields: object, message: string): void;
  fatal(fields: object, message: string): void;
}

export interface ProcessGuardOptions {
  readonly target: ProcessLike;
  readonly logger: ProcessGuardLogger;
  /** Desligamento gracioso (fecha o HTTP, espera os jobs ativos, fecha banco e Redis). */
  readonly shutdown: () => Promise<void>;
  /** Prazo global do desligamento (`SHUTDOWN_TIMEOUT_MS`): passou disso, sai com código 1. */
  readonly timeoutMs: number;
  readonly exit: (code: number) => void;
  readonly metrics?: { countProcessFatalError(kind: ProcessFatalKind): void };
}

export interface ProcessGuard {
  /** Inicia o desligamento (uma vez só); `exitCode` é o código de saída se ele terminar bem. */
  stop(reason: string, exitCode: number): void;
}

const STACK_FRAME_LIMIT = 12;

/**
 * Campos controlados de um erro fatal: tipo, `code` de um `BaseError` e os quadros da pilha (só as
 * linhas "at ...", que citam arquivo e função). **Nunca** a mensagem, a causa nem o objeto inteiro:
 * podem carregar texto de contato, e o ioredis anexa os argumentos do comando ao erro.
 */
export function describeFatalError(error: unknown): {
  errName: string;
  errCode?: string;
  stack?: string[];
} {
  const frames =
    error instanceof Error && typeof error.stack === 'string'
      ? error.stack
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.startsWith('at '))
          .slice(0, STACK_FRAME_LIMIT)
      : [];
  return {
    errName: error instanceof Error ? error.name : typeof error,
    ...(error instanceof BaseError ? { errCode: error.code } : {}),
    ...(frames.length > 0 ? { stack: frames } : {}),
  };
}

/**
 * Guarda do processo (spec 034): trata `SIGINT`/`SIGTERM`, `unhandledRejection` e
 * `uncaughtException` com **um único** desligamento gracioso e um prazo global.
 *
 * - Sinal: desliga e sai com 0. Sinal repetido não inicia um segundo desligamento.
 * - Erro fatal: log `fatal` só com campos controlados, métrica, desligamento gracioso e saída 1
 *   (o processo está em estado desconhecido; quem o supervisiona o reinicia). Um segundo erro
 *   fatal **durante** o desligamento encerra na hora.
 * - Prazo: se o desligamento não termina em `timeoutMs`, log `error` e saída 1. Os jobs que não
 *   terminaram ficam "parados" no Redis e voltam no próximo boot (entrega at-least-once, spec 011).
 */
export function installProcessGuard(options: ProcessGuardOptions): ProcessGuard {
  const { target, logger, shutdown, timeoutMs, exit, metrics } = options;
  let stopping = false;
  let exited = false;

  const exitOnce = (code: number): void => {
    if (exited) return;
    exited = true;
    exit(code);
  };

  const stop = (reason: string, exitCode: number): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ reason }, 'encerrando servidor');
    const timer = setTimeout(() => {
      logger.error({ reason, timeoutMs }, 'desligamento não terminou no prazo; encerrando à força');
      exitOnce(1);
    }, timeoutMs);
    timer.unref();
    shutdown().then(
      () => {
        clearTimeout(timer);
        exitOnce(exitCode);
      },
      (err: unknown) => {
        clearTimeout(timer);
        logger.error(describeFatalError(err), 'falha ao encerrar servidor');
        exitOnce(1);
      },
    );
  };

  const onFatal = (kind: ProcessFatalKind, error: unknown): void => {
    try {
      metrics?.countProcessFatalError(kind);
    } catch {
      // A métrica nunca impede o tratamento do erro fatal.
    }
    logger.fatal({ kind, ...describeFatalError(error) }, 'erro fatal não tratado no processo');
    if (stopping) {
      exitOnce(1);
      return;
    }
    stop(kind, 1);
  };

  target.on('SIGINT', () => {
    stop('SIGINT', 0);
  });
  target.on('SIGTERM', () => {
    stop('SIGTERM', 0);
  });
  target.on('unhandledRejection', (reason: unknown) => {
    onFatal('unhandled_rejection', reason);
  });
  target.on('uncaughtException', (error: unknown) => {
    onFatal('uncaught_exception', error);
  });

  return { stop };
}
