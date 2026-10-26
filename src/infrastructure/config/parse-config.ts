import { type Config, envSchema } from './env.schema.js';
import { Result } from '../../shared/types/index.js';

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Configuração inválida:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** Valida as variáveis de ambiente; função pura, sem efeitos colaterais. */
export function parseConfig(env: NodeJS.ProcessEnv): Result<Config, ConfigError> {
  const parsed = envSchema.safeParse(env);
  if (parsed.success) {
    return Result.ok(parsed.data);
  }
  const issues = parsed.error.issues.map((issue) => {
    const name = issue.path.map(String).join('.');
    return `${name}: ${issue.message}`;
  });
  return Result.err(new ConfigError(issues));
}
