import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Prisma } from '../../generated/prisma/client.js';
import { DatabaseError, ValidationError } from '../../shared/errors/index.js';
import {
  isDatabaseFailure,
  isRecoverableTransactionError,
  toDatabaseError,
  withDatabaseErrors,
} from './database-errors.js';

function prismaError(code: string, message = 'falha'): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: 'test' });
}

describe('toDatabaseError', () => {
  it('gera DatabaseError 500 não operacional com mensagem genérica, sem vazar SQL', () => {
    const sql = 'SELECT secret_column FROM users WHERE id = 1';
    const error = toDatabaseError(prismaError('P2010', `Invalid invocation: ${sql}`), 'consulta');

    assert.ok(error instanceof DatabaseError);
    assert.equal(error.statusCode, 500);
    assert.equal(error.isOperational, false);
    assert.equal(error.code, 'DATABASE_ERROR');
    assert.ok(!error.message.includes('secret_column'));
    assert.ok(!JSON.stringify(error.context).includes('secret_column'));
    assert.equal(error.context.operation, 'consulta');
    assert.equal(error.context.code, 'P2010');
    // O erro original fica em `cause`, só para log.
    assert.ok(error.cause instanceof Prisma.PrismaClientKnownRequestError);
  });

  it('não reembrulha um DatabaseError', () => {
    const original = new DatabaseError('x');
    assert.equal(toDatabaseError(original), original);
  });
});

describe('isDatabaseFailure', () => {
  it('reconhece erros do Prisma e de rede, e ignora erros de regra de negócio', () => {
    assert.ok(isDatabaseFailure(prismaError('P2002')));
    assert.ok(isDatabaseFailure(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })));
    assert.equal(isDatabaseFailure(new ValidationError('x')), false);
    assert.equal(isDatabaseFailure(new Error('x')), false);
    assert.equal(isDatabaseFailure('texto'), false);
  });
});

describe('isRecoverableTransactionError', () => {
  it('só P2034 e P2028 são recuperáveis', () => {
    assert.ok(isRecoverableTransactionError(prismaError('P2034')));
    assert.ok(isRecoverableTransactionError(prismaError('P2028')));
    assert.equal(isRecoverableTransactionError(prismaError('P2002')), false);
    assert.equal(isRecoverableTransactionError(new Error('P2034')), false);
  });
});

describe('withDatabaseErrors', () => {
  it('converte falha de banco e deixa passar erro de regra de negócio', async () => {
    await assert.rejects(
      withDatabaseErrors('op', () => Promise.reject(prismaError('P2010'))),
      (error: unknown) => error instanceof DatabaseError,
    );
    const business = new ValidationError('x');
    await assert.rejects(
      withDatabaseErrors('op', () => Promise.reject(business)),
      (error: unknown) => error === business,
    );
    assert.equal(await withDatabaseErrors('op', () => Promise.resolve(42)), 42);
  });
});
