/**
 * Processo auxiliar do teste de shutdown: cria as métricas (com as métricas padrão do processo
 * ligadas), abre o pool do banco e o Redis, usa os dois, fecha com `closeInfrastructure` e
 * termina SEM chamar `process.exit`. Se sobrar algum
 * handle aberto, o processo não termina sozinho e o teste que o executa falha por timeout.
 */
import { createRateLimitRedis } from '../infrastructure/cache/rate-limit-redis.js';
import { createRedis } from '../infrastructure/cache/redis.client.js';
import { createDatabase } from '../infrastructure/database/database.js';
import { closeInfrastructure } from '../infrastructure/lifecycle.js';
import { createLogger } from '../infrastructure/logger/logger.js';
import { createMetrics } from '../infrastructure/metrics/index.js';
import { loadIntegrationConfig } from './integration-env.js';

const config = loadIntegrationConfig();
const logger = createLogger(config);

const metrics = createMetrics();
const database = createDatabase(config, logger, {
  queryObserver: (sample) => {
    metrics.observeDbQuery(sample);
  },
});
metrics.bindPool(() => database.poolMetrics());
const redis = createRedis(config, logger);
const rateLimitRedis = createRateLimitRedis(config, logger);

const [databaseResult, redisResult, rateLimitReady] = await Promise.all([
  database.check(),
  redis.check(),
  rateLimitRedis.waitUntilReady(5_000),
]);
if (!databaseResult.ok || !redisResult.ok || !rateLimitReady) {
  process.stderr.write('infraestrutura indisponível no probe\n');
  process.exitCode = 2;
}

// Coleta as métricas (padrão do processo + pool) antes de fechar, como o /metrics faria.
await metrics.render();
const before = database.poolMetrics();
await closeInfrastructure({ database, redis, rateLimitRedis }, logger);
const after = database.poolMetrics();

process.stdout.write(
  `${JSON.stringify({
    poolTotalBefore: before.totalCount,
    poolTotalAfter: after.totalCount,
    redisStatus: redis.client.status,
    rateLimitRedisStatus: rateLimitRedis.client.status,
  })}\n`,
);
