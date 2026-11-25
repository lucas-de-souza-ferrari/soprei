import pg from 'pg';
import { Prisma } from '../../generated/prisma/client.js';
import { DatabaseError } from '../../shared/errors/index.js';

/** Códigos do Prisma que indicam falha transitória de transação (vale repetir). */
export const RECOVERABLE_PRISMA_CODES: ReadonlySet<string> = new Set([
  'P2034', // conflito de escrita ou deadlock
  'P2028', // transação expirada ou indisponível
]);

const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const { code } = error;
  return typeof code === 'string' ? code : undefined;
}

export function isRecoverableTransactionError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    RECOVERABLE_PRISMA_CODES.has(error.code)
  );
}

/**
 * Violação da restrição de exclusão (SQLSTATE 23P01), do jeito que o adaptador `pg` do Prisma 7 a entrega:
 * `PrismaClientKnownRequestError` (código P2039) com o código original em
 * `meta.driverAdapterError.cause.originalCode`. Também aceita o erro cru do `pg` e olha a cadeia de `cause`.
 * É o **único** lugar que conhece essa forma (spec 027: dupla reserva).
 */
export function isExclusionViolation(error: unknown): boolean {
  return hasPostgresCode(error, '23P01');
}

/**
 * Deadlock detectado pelo Postgres (SQLSTATE 40P01), na mesma forma do Prisma 7 com o adaptador `pg` (ou
 * dentro de um `DatabaseError`, pela cadeia de `cause`). Em SQL cru ele não chega como P2034, então o
 * `runInTransaction` não o repete sozinho; quem tem travas em ordem que pode cruzar com outro caminho
 * (spec 045, E2: desativar conta x `createCompany`) repete a transação inteira.
 */
export function isDeadlock(error: unknown): boolean {
  return hasPostgresCode(error, '40P01');
}

/** O SQLSTATE do erro do driver, direto, no `driverAdapterError` do Prisma 7 ou na cadeia de `cause`. */
function hasPostgresCode(error: unknown, sqlState: string, depth = 0): boolean {
  if (depth > 4 || typeof error !== 'object' || error === null) return false;
  if (errorCode(error) === sqlState) return true;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const meta: unknown = error.meta;
    if (typeof meta === 'object' && meta !== null && 'driverAdapterError' in meta) {
      const adapter: unknown = meta.driverAdapterError;
      if (typeof adapter === 'object' && adapter !== null && 'cause' in adapter) {
        const cause: unknown = adapter.cause;
        if (typeof cause === 'object' && cause !== null) {
          const record = cause as Record<string, unknown>;
          if (record['originalCode'] === sqlState || record['code'] === sqlState) return true;
        }
      }
    }
  }
  return 'cause' in error && hasPostgresCode(error.cause, sqlState, depth + 1);
}

/** Erro que veio do Prisma ou do driver `pg` (e não de regra de negócio). */
export function isDatabaseFailure(error: unknown): boolean {
  if (error instanceof DatabaseError) return true;
  if (
    error instanceof Prisma.PrismaClientKnownRequestError ||
    error instanceof Prisma.PrismaClientUnknownRequestError ||
    error instanceof Prisma.PrismaClientInitializationError ||
    error instanceof Prisma.PrismaClientRustPanicError ||
    error instanceof Prisma.PrismaClientValidationError ||
    error instanceof pg.DatabaseError
  ) {
    return true;
  }
  const code = errorCode(error);
  return code !== undefined && NETWORK_ERROR_CODES.has(code);
}

/**
 * Converte qualquer falha de banco em `DatabaseError`. A mensagem é genérica; o erro
 * original (que pode conter SQL e dados de conexão) fica em `cause` e o código em
 * `context`, só para log. Um `DatabaseError` já convertido passa sem alteração.
 */
export function toDatabaseError(error: unknown, operation?: string): DatabaseError {
  if (error instanceof DatabaseError) return error;
  return new DatabaseError('Falha ao acessar o banco de dados', {
    cause: error,
    context: {
      ...(operation === undefined ? {} : { operation }),
      errorName: error instanceof Error ? error.name : typeof error,
      ...(errorCode(error) === undefined ? {} : { code: errorCode(error) }),
    },
  });
}

/** Executa uma operação de banco e converte falhas do Prisma/driver em `DatabaseError`. */
export async function withDatabaseErrors<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isDatabaseFailure(error)) throw toDatabaseError(error, operation);
    throw error;
  }
}
