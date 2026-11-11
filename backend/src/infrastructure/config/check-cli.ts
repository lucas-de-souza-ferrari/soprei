import dotenv from 'dotenv';
import { parseConfig } from './parse-config.js';

/**
 * `pnpm config:check` (spec 037, D12): valida o `.env` do diretório atual com o MESMO schema do boot
 * (`parseConfig`), sem abrir conexão e sem iniciar nada. É o que o `deploy.sh` roda no build novo,
 * antes da migration e antes de derrubar o processo, para que um `.env` que não vale para a versão
 * nova não vire laço de reinício no PM2.
 *
 * Saída: `ok` (código 0) ou, com código 1, **só os nomes** das variáveis inválidas, um por linha.
 * Nunca o valor e nunca a mensagem do Zod (que pode repetir o valor ou ser longa).
 */

const SAFE_NAME = /^[A-Za-z0-9_.]+$/;

/** Nome da variável de um item de `ConfigError.issues` (a parte antes do primeiro `:`). */
export function issueName(issue: string): string {
  const name = issue.split(':', 1)[0]?.trim() ?? '';
  return SAFE_NAME.test(name) ? name : '(configuração)';
}

export interface ConfigCheckResult {
  readonly exitCode: 0 | 1;
  readonly lines: readonly string[];
}

/** Função pura: recebe o ambiente já carregado e devolve o código de saída e as linhas a imprimir. */
export function checkConfig(env: NodeJS.ProcessEnv): ConfigCheckResult {
  const result = parseConfig(env);
  if (result.ok) {
    return { exitCode: 0, lines: ['ok'] };
  }
  const names = [...new Set(result.error.issues.map(issueName))];
  return { exitCode: 1, lines: names };
}

function main(): void {
  // Mesmo comportamento do boot: o `.env` é o do diretório atual; variável já definida no ambiente
  // do processo vale mais que o arquivo.
  dotenv.config({ quiet: true });
  const { exitCode, lines } = checkConfig(process.env);
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exitCode = exitCode;
}

// Só roda como programa (não quando um teste importa as funções acima).
if (process.argv[1] !== undefined && /check-cli\.[cm]?[jt]s$/.test(process.argv[1])) {
  main();
}
