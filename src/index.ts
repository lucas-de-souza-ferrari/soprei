import { loadConfig } from './infrastructure/config/index.js';
import { buildServer } from './infrastructure/http/server.js';
import { createLogger } from './infrastructure/logger/logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  const app = buildServer({ logger });

  const shutdown = (signal: string): void => {
    app.log.info({ signal }, 'encerrando servidor');
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, 'falha ao encerrar servidor');
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    shutdown('SIGTERM');
  });

  try {
    await app.listen({ host: config.HOST, port: config.PORT });
  } catch (err) {
    app.log.error({ err, host: config.HOST, port: config.PORT }, 'falha ao iniciar o servidor');
    process.exit(1);
  }
}

void main();
