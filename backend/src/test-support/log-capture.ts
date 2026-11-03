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

/**
 * `raw` contém o valor? Código de 6 dígitos só conta como vazamento quando não está colado a
 * outros dígitos ou letras hexadecimais (timestamps, durações e UUIDs de requestId podem conter
 * a mesma sequência por acaso); os demais valores são comparados como texto.
 */
export function logContains(raw: string, value: string): boolean {
  if (!/^\d{6}$/.test(value)) return raw.includes(value);
  return new RegExp(`(?<![0-9a-fA-F])${value}(?![0-9a-fA-F])`).test(raw);
}
