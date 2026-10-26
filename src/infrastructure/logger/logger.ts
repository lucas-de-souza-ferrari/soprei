import { pino, type Logger, type LoggerOptions } from 'pino';
import type { Config } from '../config/index.js';

type LoggerConfig = Pick<Config, 'NODE_ENV' | 'LOG_LEVEL'>;

/** JSON estruturado em produção e nos testes; `pino-pretty` só em desenvolvimento. */
export function createLoggerOptions(config: LoggerConfig): LoggerOptions {
  return {
    level: config.LOG_LEVEL,
    ...(config.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  };
}

export function createLogger(config: LoggerConfig): Logger {
  return pino(createLoggerOptions(config));
}
