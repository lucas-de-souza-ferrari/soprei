import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BaseError,
  DatabaseError,
  ExternalServiceError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from './index.js';

describe('hierarquia de erros', () => {
  const cases = [
    { create: () => new ValidationError(), statusCode: 400, code: 'VALIDATION_ERROR' },
    { create: () => new UnauthorizedError(), statusCode: 401, code: 'UNAUTHORIZED' },
    { create: () => new ForbiddenError(), statusCode: 403, code: 'FORBIDDEN' },
    { create: () => new NotFoundError(), statusCode: 404, code: 'NOT_FOUND' },
    { create: () => new DatabaseError(), statusCode: 500, code: 'DATABASE_ERROR' },
    { create: () => new ExternalServiceError(), statusCode: 502, code: 'EXTERNAL_SERVICE_ERROR' },
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

  it('DatabaseError não é operacional', () => {
    assert.equal(new DatabaseError().isOperational, false);
  });
});
