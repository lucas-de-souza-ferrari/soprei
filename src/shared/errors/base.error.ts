export type ErrorContext = Readonly<Record<string, unknown>>;

export interface BaseErrorParams {
  readonly message: string;
  readonly code: string;
  readonly statusCode: number;
  readonly isOperational?: boolean;
  readonly context?: ErrorContext;
  readonly cause?: unknown;
}

/**
 * Raiz da hierarquia de erros da aplicação.
 *
 * - `isOperational`: erro esperado (entrada inválida, recurso inexistente...), em
 *   oposição a um bug ou falha inesperada.
 * - `context`: dados para diagnóstico. Vai para o log, nunca para a resposta HTTP.
 */
export class BaseError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly isOperational: boolean;
  readonly context: ErrorContext;

  constructor(params: BaseErrorParams) {
    super(params.message, params.cause === undefined ? undefined : { cause: params.cause });
    this.name = new.target.name;
    this.code = params.code;
    this.statusCode = params.statusCode;
    this.isOperational = params.isOperational ?? true;
    this.context = params.context ?? {};
  }
}
