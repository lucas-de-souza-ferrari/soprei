import { BaseError } from '../../shared/errors/index.js';

/**
 * Campos controlados de um erro para o log do canal: só o nome do tipo e o `code` de um
 * `BaseError`. Nunca a mensagem, a causa nem o `context` livre (podem citar dado do contato) e
 * nunca o objeto inteiro (o ioredis anexa `command.args` aos erros de comando).
 */
export function describeError(error: unknown): { errName: string; errCode?: string } {
  return {
    errName: error instanceof Error ? error.name : typeof error,
    ...(error instanceof BaseError ? { errCode: error.code } : {}),
  };
}
