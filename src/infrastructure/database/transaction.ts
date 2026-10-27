import { setTimeout as sleepMs } from 'node:timers/promises';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  isDatabaseFailure,
  isRecoverableTransactionError,
  toDatabaseError,
} from './database-errors.js';
import type { TenantScopedDb, TenantScopedPrisma } from './extensions/tenant-scope.js';

export interface RetryOptions {
  /** Repetições depois da primeira tentativa. */
  readonly maxRetries?: number;
  /** Espera antes da 1ª repetição; dobra a cada nova repetição (com jitter). */
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Injetável para os testes não esperarem de verdade. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface TransactionOptions extends RetryOptions {
  /** Tempo máximo esperando uma conexão do pool para abrir a transação. */
  readonly maxWait?: number;
  /** Tempo máximo da transação inteira. */
  readonly timeout?: number;
  readonly isolationLevel?: Prisma.TransactionIsolationLevel;
}

const DEFAULTS = {
  maxRetries: 3,
  baseDelayMs: 50,
  maxDelayMs: 2_000,
  maxWait: 5_000,
  timeout: 15_000,
} as const;

export function backoffDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponential = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
  // Jitter de até 25% evita que transações em conflito repitam todas no mesmo instante.
  return Math.round(exponential * (1 + Math.random() * 0.25));
}

/**
 * Repete `fn` com backoff exponencial somente em erro recuperável (P2034, P2028).
 * Qualquer outro erro, e o recuperável depois de esgotar as repetições, sobe como está.
 */
export async function retryOnRecoverable<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULTS.maxRetries;
  const baseDelayMs = options.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const sleep = options.sleep ?? ((ms: number) => sleepMs(ms));

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= maxRetries || !isRecoverableTransactionError(error)) throw error;
      await sleep(backoffDelayMs(attempt, baseDelayMs, maxDelayMs));
    }
  }
}

/**
 * Transação interativa com retry. Se `fn` lança, o Prisma faz rollback. Falhas do
 * Prisma/driver saem como `DatabaseError`; erros de regra de negócio lançados por `fn`
 * sobem intactos (e não são repetidos).
 */
export async function runInTransaction<T>(
  prisma: TenantScopedPrisma,
  fn: (tx: TenantScopedDb) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  try {
    return await retryOnRecoverable(
      () =>
        prisma.$transaction(fn, {
          maxWait: options.maxWait ?? DEFAULTS.maxWait,
          timeout: options.timeout ?? DEFAULTS.timeout,
          ...(options.isolationLevel === undefined
            ? {}
            : { isolationLevel: options.isolationLevel }),
        }),
      options,
    );
  } catch (error) {
    if (isDatabaseFailure(error)) throw toDatabaseError(error, 'transaction');
    throw error;
  }
}
