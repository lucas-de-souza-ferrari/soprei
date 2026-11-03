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
    // `TRUST_PROXY` vazio vale como `false`; com o canal ligado isso precisa ser uma escolha
    // explícita (ver a spec 011): atrás de túnel/proxy o padrão faria a Meta e qualquer atacante
    // dividirem a cota do perfil `webhook`. A checagem é aqui porque o schema já perdeu a
    // distinção entre "ausente" e "false".
    if (parsed.data.WHATSAPP_ENABLED && (env.TRUST_PROXY ?? '').trim() === '') {
      return Result.err(
        new ConfigError([
          'TRUST_PROXY: precisa ser definida explicitamente com WHATSAPP_ENABLED=true (mesmo que "false"); atrás de túnel ou proxy liste os IPs/CIDRs dele, ex.: 127.0.0.1,::1',
        ]),
      );
    }
    return Result.ok(parsed.data);
  }
  const issues = parsed.error.issues.map((issue) => {
    const name = issue.path.map(String).join('.');
    return `${name}: ${issue.message}`;
  });
  return Result.err(new ConfigError(issues));
}
