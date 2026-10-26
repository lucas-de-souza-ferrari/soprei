import { BaseError, type ErrorContext } from './base.error.js';

export interface AppErrorOptions {
  readonly context?: ErrorContext;
  readonly cause?: unknown;
}

export class ValidationError extends BaseError {
  constructor(message = 'Dados inválidos', options: AppErrorOptions = {}) {
    super({ message, code: 'VALIDATION_ERROR', statusCode: 400, ...options });
  }
}

export class UnauthorizedError extends BaseError {
  constructor(message = 'Não autenticado', options: AppErrorOptions = {}) {
    super({ message, code: 'UNAUTHORIZED', statusCode: 401, ...options });
  }
}

export class ForbiddenError extends BaseError {
  constructor(message = 'Acesso negado', options: AppErrorOptions = {}) {
    super({ message, code: 'FORBIDDEN', statusCode: 403, ...options });
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
