import { Prisma } from '../../generated/prisma/client.js';
import { ConflictError, DatabaseError } from '../../shared/errors/index.js';
import { withDatabaseErrors } from './database-errors.js';

/**
 * Como `withDatabaseErrors`, mas violação de unicidade (`P2002`) vira `ConflictError` (409),
 * que é um erro esperado. O erro original fica em `cause`; a mensagem não revela coluna,
 * valor nem SQL. O resto das falhas do Prisma/driver vira `DatabaseError`.
 */
export async function withRepositoryErrors<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await withDatabaseErrors(operation, fn);
  } catch (error) {
    if (
      error instanceof DatabaseError &&
      error.cause instanceof Prisma.PrismaClientKnownRequestError &&
      error.cause.code === 'P2002'
    ) {
      throw new ConflictError('Já existe um registro com estes dados', {
        cause: error.cause,
        context: { operation },
      });
    }
    throw error;
  }
}
