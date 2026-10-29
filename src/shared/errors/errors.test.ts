import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BaseError,
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
} from './index.js';

describe('hierarquia de erros', () => {
  const cases = [
    { create: () => new RateLimitError(30), statusCode: 429, code: 'RATE_LIMITED' },
    { create: () => new ValidationError(), statusCode: 400, code: 'VALIDATION_ERROR' },
    { create: () => new UnauthorizedError(), statusCode: 401, code: 'UNAUTHORIZED' },
    { create: () => new ForbiddenError(), statusCode: 403, code: 'FORBIDDEN' },
    { create: () => new NotFoundError(), statusCode: 404, code: 'NOT_FOUND' },
    { create: () => new ConflictError(), statusCode: 409, code: 'CONFLICT' },
    { create: () => new DatabaseError(), statusCode: 500, code: 'DATABASE_ERROR' },
    { create: () => new TenantScopeError(), statusCode: 500, code: 'TENANT_SCOPE_ERROR' },
    { create: () => new ExternalServiceError(), statusCode: 502, code: 'EXTERNAL_SERVICE_ERROR' },
    { create: () => new ServiceUnavailableError(), statusCode: 503, code: 'SERVICE_UNAVAILABLE' },
  ];

  for (const { create, statusCode, code } of cases) {
    it(`${create().name} tem statusCode ${statusCode} e code ${code}`, () => {
      const error = create();
      assert.ok(error instanceof BaseError);
      assert.ok(error instanceof Error);
      assert.equal(error.statusCode, statusCode);
      assert.equal(error.code, code);
    });
  }

  it('ServiceUnavailableError é operacional (falha esperada da dependência, não bug)', () => {
    assert.equal(new ServiceUnavailableError().isOperational, true);
  });

  it('guarda context e cause', () => {
    const cause = new Error('origem');
    const error = new NotFoundError('Cliente não encontrado', {
      context: { clientId: 'c1' },
      cause,
    });
    assert.equal(error.message, 'Cliente não encontrado');
    assert.deepEqual(error.context, { clientId: 'c1' });
    assert.equal(error.cause, cause);
    assert.equal(error.isOperational, true);
  });

  it('DatabaseError e TenantScopeError não são operacionais; ConflictError é', () => {
    assert.equal(new DatabaseError().isOperational, false);
    assert.equal(new TenantScopeError().isOperational, false);
    assert.equal(new ConflictError().isOperational, true);
  });

  it('RateLimitError guarda retryAfterSeconds inteiro >= 1 no erro e no context', () => {
    const error = new RateLimitError(12.2);
    assert.equal(error.retryAfterSeconds, 13);
    assert.deepEqual(error.context, { retryAfterSeconds: 13 });
    assert.equal(error.isOperational, true);
    assert.equal(new RateLimitError(0).retryAfterSeconds, 1);
    assert.equal(new RateLimitError(-5).retryAfterSeconds, 1);
    assert.equal(new RateLimitError(Number.NaN).retryAfterSeconds, 1);
  });
});
