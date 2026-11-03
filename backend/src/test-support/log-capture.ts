import { Writable } from 'node:stream';
import type { Logger } from 'pino';
import type { Config } from '../infrastructure/config/index.js';
import { createLogger } from '../infrastructure/logger/logger.js';

export type LogLine = Record<string, unknown>;

export interface LogCapture {
  readonly logger: Logger;
  /** Linhas JSON emitidas até agora, já parseadas. */
  lines(): LogLine[];
  /** Texto cru de tudo o que foi emitido (para procurar segredos). */
  raw(): string;
}

/** Logger Pino de produção (mixin e redact) escrevendo em memória, para os testes lerem. */
export function captureLogs(level: Config['LOG_LEVEL'] = 'trace'): LogCapture {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: level }, destination);
  return {
    logger,
    raw: () => chunks.join(''),
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as LogLine),
  };
}
