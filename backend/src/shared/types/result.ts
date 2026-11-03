export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

/** Resultado de operações cujo erro é esperado (chamada de LLM, canal externo...). */
export type Result<T, E = Error> = Ok<T> | Err<E>;

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason), { cause: reason });
}

export const Result = {
  ok<T>(value: T): Ok<T> {
    return { ok: true, value };
  },

  err<E>(error: E): Err<E> {
    return { ok: false, error };
  },

  /** Converte uma promise em `Result`: resolve vira `ok`, rejeição vira `err`. */
  async from<T>(promise: Promise<T>): Promise<Result<T>> {
    try {
      return Result.ok(await promise);
    } catch (reason) {
      return Result.err(toError(reason));
    }
  },
} as const;
