import { PrismaPg } from '@prisma/adapter-pg';
import type { FastifyBaseLogger } from 'fastify';
import pg from 'pg';
import { PrismaClient } from '../../generated/prisma/client.js';
import type { DatabaseError } from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import { withTimeout } from '../../shared/utils/index.js';
import { type Config, loadConfig } from '../config/index.js';
import { createLogger } from '../logger/logger.js';
import { toDatabaseError } from './database-errors.js';
import { type QueryObserver, queryTimingExtension } from './extensions/query-timing.js';
import { extendWithTenantScope, type TenantScopedPrisma } from './extensions/tenant-scope.js';

export type DatabaseConfig = Pick<
  Config,
  | 'DATABASE_URL'
  | 'DB_POOL_MAX'
  | 'DB_POOL_IDLE_TIMEOUT_MS'
  | 'DB_POOL_CONNECTION_TIMEOUT_MS'
  | 'DB_STATEMENT_TIMEOUT_MS'
>;

export interface PoolMetrics {
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
}

export interface Database {
  /** Client do Prisma com a segunda barreira de isolamento entre clientes (tenant-scope). */
  readonly prisma: TenantScopedPrisma;
  /** Verifica o banco com `SELECT 1`. Nunca lança: a falha volta como `DatabaseError`. */
  check(timeoutMs?: number): Promise<Result<void, DatabaseError>>;
  /** Números do pool, para a spec de métricas publicar. */
  poolMetrics(): PoolMetrics;
  /** Encerra o Prisma e o pool. Idempotente. */
  close(): Promise<void>;
}

const DEFAULT_CHECK_TIMEOUT_MS = 2_000;

/**
 * O parâmetro `schema` da URL é do Prisma, não do `pg`: sai da connection string e vai
 * para o adapter. O resto da URL (inclusive `sslmode`) segue intacto para o `pg`.
 */
function splitConnectionString(databaseUrl: string): {
  connectionString: string;
  schema: string | undefined;
} {
  const url = new URL(databaseUrl);
  const schema = url.searchParams.get('schema') ?? undefined;
  url.searchParams.delete('schema');
  return { connectionString: url.toString(), schema };
}

export interface CreateDatabaseOptions {
  /** Recebe a duração de cada query de model (métricas). Falha do observer vira só um `warn`. */
  readonly queryObserver?: QueryObserver;
}

/** O observer de métrica nunca derruba uma query: a falha dele é só logada. */
function safeObserver(
  observer: QueryObserver | undefined,
  logger: FastifyBaseLogger,
): QueryObserver {
  return (sample) => {
    if (observer === undefined) return;
    try {
      observer(sample);
    } catch (err) {
      logger.warn({ err }, 'falha ao registrar métrica de query');
    }
  };
}

/** Cria um `PrismaClient` sobre um pool `pg` configurado. Prefira `getDatabase()`. */
export function createDatabase(
  config: DatabaseConfig,
  logger: FastifyBaseLogger,
  options: CreateDatabaseOptions = {},
): Database {
  const { connectionString, schema } = splitConnectionString(config.DATABASE_URL);
  const pool = new pg.Pool({
    connectionString,
    max: config.DB_POOL_MAX,
    idleTimeoutMillis: config.DB_POOL_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: config.DB_POOL_CONNECTION_TIMEOUT_MS,
    statement_timeout: config.DB_STATEMENT_TIMEOUT_MS,
    application_name: 'soprei',
  });
  // Sem listener, o erro de um client ocioso derrubaria o processo.
  pool.on('error', (err) => {
    logger.error({ err }, 'erro em conexão ociosa do pool do PostgreSQL');
  });

  const adapter = new PrismaPg(pool, {
    ...(schema === undefined ? {} : { schema }),
    disposeExternalPool: true,
  });
  // Ordem das extensões: tenant-scope primeiro (barreira de isolamento, a mais externa), depois
  // a de tempo, que só mede o que a barreira deixou passar. Ver query-timing.ts.
  const prisma = extendWithTenantScope(new PrismaClient({ adapter })).$extends(
    queryTimingExtension(safeObserver(options.queryObserver, logger)),
  );

  let closing: Promise<void> | undefined;

  return {
    prisma,
    async check(timeoutMs = DEFAULT_CHECK_TIMEOUT_MS) {
      try {
        await withTimeout(prisma.$queryRaw`SELECT 1`, timeoutMs, 'banco de dados');
        return Result.ok(undefined);
      } catch (error) {
        return Result.err(toDatabaseError(error, 'health-check'));
      }
    },
    poolMetrics: () => getPoolMetrics(pool),
    close() {
      // `$disconnect` encerra o adapter e, por `disposeExternalPool`, o pool.
      closing ??= prisma.$disconnect();
      return closing;
    },
  };
}

export function getPoolMetrics(pool: pg.Pool): PoolMetrics {
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  };
}

export interface GetDatabaseOptions extends CreateDatabaseOptions {
  readonly config: DatabaseConfig;
  readonly logger: FastifyBaseLogger;
}

let instance: Database | undefined;

/**
 * Único `PrismaClient` do processo. A primeira chamada o cria (com `options` ou, se
 * omitidas, com a config do ambiente); as demais devolvem a mesma instância.
 */
export function getDatabase(options?: GetDatabaseOptions): Database {
  if (instance === undefined) {
    const resolved = options ?? defaultOptions();
    instance = createDatabase(resolved.config, resolved.logger, {
      ...(resolved.queryObserver === undefined ? {} : { queryObserver: resolved.queryObserver }),
    });
  }
  return instance;
}

export function getPrisma(): TenantScopedPrisma {
  return getDatabase().prisma;
}

/** Fecha o singleton e libera o slot, para o shutdown e para os testes. */
export async function closeDatabase(): Promise<void> {
  const current = instance;
  instance = undefined;
  await current?.close();
}

function defaultOptions(): GetDatabaseOptions {
  const config = loadConfig();
  return { config, logger: createLogger(config) };
}
