import { BaseError, type ErrorContext } from './base.error.js';

export interface AppErrorOptions {
  readonly context?: ErrorContext;
  readonly cause?: unknown;
}

export class ValidationError extends BaseError {
  /** `options.code` dá à validação um código próprio (ex.: `CHANNEL_WRONG_APP`); sem ele, `VALIDATION_ERROR`. */
  constructor(
    message = 'Dados inválidos',
    options: AppErrorOptions & { readonly code?: string } = {},
  ) {
    const { code, ...rest } = options;
    super({ message, statusCode: 400, ...rest, code: code ?? 'VALIDATION_ERROR' });
  }
}

export class UnauthorizedError extends BaseError {
  constructor(message = 'Não autenticado', options: AppErrorOptions = {}) {
    super({ message, code: 'UNAUTHORIZED', statusCode: 401, ...options });
  }
}

export class ForbiddenError extends BaseError {
  /** `options.code` dá à recusa um código próprio (ex.: `PLAN_COMPANY_LIMIT`); sem ele, `FORBIDDEN`. */
  constructor(
    message = 'Acesso negado',
    options: AppErrorOptions & { readonly code?: string } = {},
  ) {
    const { code, ...rest } = options;
    super({ message, statusCode: 403, ...rest, code: code ?? 'FORBIDDEN' });
  }
}

export class NotFoundError extends BaseError {
  constructor(message = 'Recurso não encontrado', options: AppErrorOptions = {}) {
    super({ message, code: 'NOT_FOUND', statusCode: 404, ...options });
  }
}

export class DatabaseError extends BaseError {
  constructor(message = 'Erro de banco de dados', options: AppErrorOptions = {}) {
    super({ message, code: 'DATABASE_ERROR', statusCode: 500, isOperational: false, ...options });
  }
}

export class ExternalServiceError extends BaseError {
  constructor(message = 'Falha em serviço externo', options: AppErrorOptions = {}) {
    super({ message, code: 'EXTERNAL_SERVICE_ERROR', statusCode: 502, ...options });
  }
}

export class ConflictError extends BaseError {
  /** `options.code` dá ao conflito um código próprio (ex.: `LAST_OWNER`); sem ele, `CONFLICT`. */
  constructor(
    message = 'Conflito com o estado atual do recurso',
    options: AppErrorOptions & { readonly code?: string } = {},
  ) {
    const { code, ...rest } = options;
    super({ message, statusCode: 409, ...rest, code: code ?? 'CONFLICT' });
  }
}

/**
 * Operação de dado de tenant sem o filtro por empresa (ou proibida por não carregá-lo).
 * É erro de programação, nunca de entrada do usuário: 500 e não operacional.
 */
export class TenantScopeError extends BaseError {
  constructor(message = 'Operação de tenant sem escopo de empresa', options: AppErrorOptions = {}) {
    super({
      message,
      code: 'TENANT_SCOPE_ERROR',
      statusCode: 500,
      isOperational: false,
      ...options,
    });
  }
}

/**
 * Limite de requisições excedido (spec 005): 429. `retryAfterSeconds` (inteiro >= 1) também
 * vai no `context`, para o log, e é o que o handler central devolve como `retryAfter`.
 */
export class RateLimitError extends BaseError {
  readonly retryAfterSeconds: number;

  constructor(
    retryAfterSeconds: number,
    message = 'Muitas requisições. Tente novamente em instantes.',
    options: AppErrorOptions & { readonly code?: string } = {},
  ) {
    const seconds = Number.isFinite(retryAfterSeconds)
      ? Math.max(1, Math.ceil(retryAfterSeconds))
      : 1;
    super({
      message,
      code: 'RATE_LIMITED',
      statusCode: 429,
      ...options,
      context: { ...options.context, retryAfterSeconds: seconds },
    });
    this.retryAfterSeconds = seconds;
  }
}

/**
 * Dependência de que a operação não pode prescindir está fora (ex.: o Redis das sessões, spec
 * 007): 503, operacional. É a falha **fechada** da autenticação: nada é aceito nem emitido. Não
 * anexe `cause` de empresa Redis (o erro do ioredis carrega `command.args`).
 */
export class ServiceUnavailableError extends BaseError {
  constructor(message = 'Serviço temporariamente indisponível', options: AppErrorOptions = {}) {
    super({ message, code: 'SERVICE_UNAVAILABLE', statusCode: 503, ...options });
  }
}

export type CredentialDecryptionReason = 'malformed' | 'unknown_key' | 'tampered';

/**
 * Falha ao decifrar uma credencial guardada (spec 015): formato inválido, chave ausente ou tag que
 * não confere (inclui texto cifrado de outra empresa, pela AAD). Mensagem fixa; o `context` leva só
 * `reason`, **nunca** o texto cifrado, o `companyId` nem a chave. É falha nossa (não da empresa):
 * 500 não operacional para quem chamar por HTTP, permanente no worker.
 */
export class CredentialDecryptionError extends BaseError {
  readonly reason: CredentialDecryptionReason;

  constructor(reason: CredentialDecryptionReason) {
    super({
      message: 'Não foi possível decifrar a credencial guardada',
      code: 'CREDENTIAL_DECRYPTION_ERROR',
      statusCode: 500,
      isOperational: false,
      context: { reason },
    });
    this.reason = reason;
  }
}
