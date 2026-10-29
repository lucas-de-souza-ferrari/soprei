export { BaseError } from './base.error.js';
export type { BaseErrorParams, ErrorContext } from './base.error.js';
export {
  ConflictError,
  DatabaseError,
  ExternalServiceError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  ServiceUnavailableError,
  TenantScopeError,
  UnauthorizedError,
  ValidationError,
} from './app.errors.js';
export type { AppErrorOptions } from './app.errors.js';
