/**
 * Processo auxiliar do teste de shutdown: abre o pool do banco e o Redis, usa os dois,
 * fecha com `closeInfrastructure` e termina SEM chamar `process.exit`. Se sobrar algum
 * handle aberto, o processo não termina sozinho e o teste que o executa falha por timeout.
 */
import { createRedis } from '../infrastructure/cache/redis.client.js';
import { createDatabase } from '../infrastructure/database/database.js';
import { closeInfrastructure } from '../infrastructure/lifecycle.js';
import { createLogger } from '../infrastructure/logger/logger.js';
import { loadIntegrationConfig } from './integration-env.js';

const config = loadIntegrationConfig();
const logger = createLogger(config);

const database = createDatabase(config, logger);
const redis = createRedis(config, logger);

const [databaseResult, redisResult] = await Promise.all([database.check(), redis.check()]);
if (!databaseResult.ok || !redisResult.ok) {
  process.stderr.write('infraestrutura indisponível no probe\n');
  process.exitCode = 2;
}

const before = database.poolMetrics();
await closeInfrastructure({ database, redis }, logger);
const after = database.poolMetrics();

process.stdout.write(
  `${JSON.stringify({
    poolTotalBefore: before.totalCount,
    poolTotalAfter: after.totalCount,
    redisStatus: redis.client.status,
  })}\n`,
);
