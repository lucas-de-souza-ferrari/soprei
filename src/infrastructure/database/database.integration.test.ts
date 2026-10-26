import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { Prisma } from '../../generated/prisma/client.js';
import { DatabaseError, ValidationError } from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import { getClosedPort, withPort } from '../../test-support/closed-port.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { buildServer } from '../http/server.js';
import { createLogger } from '../logger/logger.js';
import { createDatabase, type Database } from './database.js';
import { withDatabaseErrors } from './database-errors.js';
import { runInTransaction } from './transaction.js';

// Falha aqui (antes de abrir qualquer conexão) se o ambiente não for o de testes.
const config = loadIntegrationConfig();
const logger = createLogger(config);

let database: Database;
// Tabela própria deste arquivo, criada e removida por ele no banco de testes.
const table = `soprei_it_tx_${randomBytes(4).toString('hex')}`;

async function countRows(): Promise<number> {
  const rows = await database.prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*) AS n FROM ${table}`,
  );
  return Number(rows[0]?.n ?? 0);
}

before(async () => {
  database = createDatabase(config, logger);
  await database.prisma.$executeRawUnsafe(`CREATE TABLE ${table} (id integer PRIMARY KEY)`);
});

after(async () => {
  try {
    await database.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${table}`);
  } finally {
    await database.close();
  }
});

describe('conexão com o PostgreSQL de testes', () => {
  it('check() responde ok com o banco no ar', async () => {
    const result = await database.check();
    assert.ok(result.ok);
  });

  it('está conectado ao banco soprei_test', async () => {
    const rows = await database.prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
    assert.equal(rows[0]?.db, 'soprei_test');
  });

  it('expõe métricas do pool depois de usar uma conexão', async () => {
    await database.prisma.$queryRaw`SELECT 1`;
    const metrics = database.poolMetrics();
    assert.ok(metrics.totalCount >= 1);
    assert.ok(metrics.totalCount <= config.DB_POOL_MAX);
    assert.equal(metrics.waitingCount, 0);
    assert.ok(metrics.idleCount <= metrics.totalCount);
  });

  it('check() devolve DatabaseError (sem lançar) quando o banco está inacessível', async () => {
    const unreachable = createDatabase(
      {
        ...config,
        DATABASE_URL: withPort(config.DATABASE_URL, await getClosedPort()),
        DB_POOL_CONNECTION_TIMEOUT_MS: 1_000,
      },
      logger,
    );
    try {
      const result = await unreachable.check();
      assert.equal(result.ok, false);
      assert.ok(result.error instanceof DatabaseError);
    } finally {
      await unreachable.close();
    }
  });
});

describe('statement_timeout', () => {
  it('query que excede o limite vira DatabaseError sem vazar SQL', async () => {
    const slow = createDatabase({ ...config, DB_STATEMENT_TIMEOUT_MS: 200 }, logger);
    try {
      await assert.rejects(
        () =>
          withDatabaseErrors(
            'teste',
            () => slow.prisma.$queryRaw`SELECT pg_sleep(3) AS secret_probe`,
          ),
        (error: unknown) => {
          assert.ok(error instanceof DatabaseError);
          assert.equal(error.statusCode, 500);
          assert.ok(!error.message.includes('pg_sleep'));
          assert.ok(!error.message.includes('secret_probe'));
          return true;
        },
      );
    } finally {
      await slow.close();
    }
  });

  it('a resposta HTTP de um DatabaseError não contém SQL nem detalhes internos', async () => {
    const slow = createDatabase({ ...config, DB_STATEMENT_TIMEOUT_MS: 200 }, logger);
    const app = buildServer({
      logger,
      readiness: {
        database: () => slow.check(),
        redis: () => Promise.resolve(Result.ok(undefined)),
      },
    });
    app.get('/boom', async () => {
      await withDatabaseErrors(
        'boom',
        () => slow.prisma.$queryRaw`SELECT pg_sleep(3) AS secret_probe`,
      );
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/boom' });
      assert.equal(response.statusCode, 500);
      assert.ok(!response.body.includes('pg_sleep'));
      assert.ok(!response.body.includes('secret_probe'));
      assert.ok(!response.body.includes('SELECT'));
      assert.equal(response.json<{ error: { code: string } }>().error.code, 'DATABASE_ERROR');
    } finally {
      await app.close();
      await slow.close();
    }
  });
});

describe('runInTransaction', () => {
  it('confirma (commit) quando a função termina sem erro', async () => {
    const result = await runInTransaction(database.prisma, async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO ${table} (id) VALUES (1)`);
      return 'feito';
    });
    assert.equal(result, 'feito');
    assert.equal(await countRows(), 1);
  });

  it('faz rollback quando a função lança e relança o erro de regra de negócio intacto', async () => {
    const business = new ValidationError('regra violada');
    await assert.rejects(
      runInTransaction(database.prisma, async (tx) => {
        await tx.$executeRawUnsafe(`INSERT INTO ${table} (id) VALUES (100)`);
        throw business;
      }),
      (error: unknown) => error === business,
    );
    const rows = await database.prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM ${table} WHERE id = 100`,
    );
    assert.equal(Number(rows[0]?.n), 0);
  });

  it('repete em P2034 com backoff (erro simulado) e persiste só a última tentativa', async () => {
    const delays: number[] = [];
    let attempts = 0;
    await runInTransaction(
      database.prisma,
      async (tx) => {
        attempts++;
        await tx.$executeRawUnsafe(`INSERT INTO ${table} (id) VALUES (200)`);
        if (attempts < 3) {
          throw new Prisma.PrismaClientKnownRequestError('conflito simulado', {
            code: 'P2034',
            clientVersion: 'test',
          });
        }
      },
      {
        baseDelayMs: 10,
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      },
    );

    assert.equal(attempts, 3);
    assert.equal(delays.length, 2);
    assert.ok(delays[1] !== undefined && delays[0] !== undefined && delays[1] > delays[0]);
    const rows = await database.prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM ${table} WHERE id = 200`,
    );
    // As duas primeiras tentativas deram rollback: sobra uma única linha, da última.
    assert.equal(Number(rows[0]?.n), 1);
  });

  it('não repete erro não recuperável', async () => {
    let attempts = 0;
    await assert.rejects(
      runInTransaction(
        database.prisma,
        async (tx) => {
          attempts++;
          // Chave primária duplicada: erro do banco, mas não recuperável.
          await tx.$executeRawUnsafe(`INSERT INTO ${table} (id) VALUES (1)`);
        },
        { sleep: () => Promise.resolve() },
      ),
      (error: unknown) => error instanceof DatabaseError,
    );
    assert.equal(attempts, 1);
  });

  it('transação que estoura o timeout vira DatabaseError', async () => {
    await assert.rejects(
      runInTransaction(
        database.prisma,
        async (tx) => {
          await tx.$queryRaw`SELECT pg_sleep(2)`;
        },
        { timeout: 300, maxRetries: 0 },
      ),
      (error: unknown) => error instanceof DatabaseError && !error.message.includes('pg_sleep'),
    );
  });

  it('aceita nível de isolamento configurável', async () => {
    const level = await runInTransaction(
      database.prisma,
      async (tx) => {
        const rows = await tx.$queryRaw<
          { transaction_isolation: string }[]
        >`SHOW transaction_isolation`;
        return rows[0]?.transaction_isolation;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    assert.equal(level, 'serializable');
  });
});
