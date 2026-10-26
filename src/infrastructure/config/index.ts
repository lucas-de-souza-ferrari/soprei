import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import type { Config } from './env.schema.js';
import { parseConfig } from './parse-config.js';

export type { Config } from './env.schema.js';
export { ConfigError, parseConfig } from './parse-config.js';

const ENV_FILE = resolve(process.cwd(), '.env');

/**
 * Único ponto de acesso às variáveis de ambiente. Se a validação falhar, escreve o
 * motivo em stderr (o logger ainda não existe) e encerra o processo com código 1.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  dotenv.config({ quiet: true, processEnv: env });

  const result = parseConfig(env);
  if (result.ok) {
    return result.value;
  }

  const lines = [result.error.message];
  if (!existsSync(ENV_FILE) && env.NODE_ENV !== 'production') {
    lines.push(
      'Arquivo .env não encontrado. Em desenvolvimento, copie o exemplo: cp .env.example .env',
    );
  }
  process.stderr.write(`${lines.join('\n')}\n`);
  process.exit(1);
}
