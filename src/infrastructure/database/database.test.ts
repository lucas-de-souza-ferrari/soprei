import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { createLogger } from '../logger/logger.js';
import { closeDatabase, getDatabase } from './database.js';
import * as databaseModule from './index.js';

// O pool do `pg` só abre conexão na primeira query: estes testes não precisam de banco.
const config = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db?schema=public',
  DB_POOL_MAX: 3,
  DB_POOL_IDLE_TIMEOUT_MS: 1_000,
  DB_POOL_CONNECTION_TIMEOUT_MS: 1_000,
  DB_STATEMENT_TIMEOUT_MS: 1_000,
};
const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });

after(async () => {
  await closeDatabase();
});

describe('singleton do PrismaClient', () => {
  it('importar o módulo duas vezes devolve a mesma instância', async () => {
    const [first, second] = await Promise.all([import('./index.js'), import('./database.js')]);
    const prisma = getDatabase({ config, logger }).prisma;

    assert.equal(first.getPrisma(), prisma);
    assert.equal(second.getPrisma(), prisma);
    assert.equal(databaseModule.getDatabase(), getDatabase());
    assert.equal(databaseModule.getPrisma(), prisma);
  });

  it('closeDatabase libera o slot e a próxima chamada cria outra instância', async () => {
    const previous = getDatabase({ config, logger });
    await closeDatabase();
    const next = getDatabase({ config, logger });
    assert.notEqual(next, previous);
  });
});

describe('métricas do pool', () => {
  it('expõe totalCount, idleCount e waitingCount', () => {
    const metrics = getDatabase({ config, logger }).poolMetrics();
    assert.deepEqual(metrics, { totalCount: 0, idleCount: 0, waitingCount: 0 });
  });
});
