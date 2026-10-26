import { type Config, parseConfig } from '../infrastructure/config/index.js';

export const TEST_DATABASE_NAME = 'soprei_test';
export const TEST_REDIS_DB_INDEX = 15;

const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

export class UnsafeIntegrationEnvError extends Error {
  constructor(reason: string) {
    super(
      `Testes de integração recusados: ${reason}. Eles só rodam contra o banco "${TEST_DATABASE_NAME}" ` +
        `e o Redis /${String(TEST_REDIS_DB_INDEX)}, em localhost. Crie o .env.test a partir do .env.test.example.`,
    );
    this.name = 'UnsafeIntegrationEnvError';
  }
}

function parseUrl(raw: string | undefined, name: string): URL {
  if (raw === undefined || raw === '') {
    throw new UnsafeIntegrationEnvError(`${name} ausente`);
  }
  try {
    return new URL(raw);
  } catch {
    // Nunca ecoa o valor: a URL pode conter senha.
    throw new UnsafeIntegrationEnvError(`${name} não é uma URL válida`);
  }
}

/**
 * Trava de segurança dos testes de integração: recusa (lança) se as URLs não apontarem
 * para o banco de testes e o índice de Redis de testes. As mensagens nunca incluem a URL.
 */
export function assertSafeIntegrationEnv(env: NodeJS.ProcessEnv): void {
  const database = parseUrl(env.DATABASE_URL, 'DATABASE_URL');
  const redis = parseUrl(env.REDIS_URL, 'REDIS_URL');

  const databaseName = decodeURIComponent(database.pathname.replace(/^\//, ''));
  if (databaseName !== TEST_DATABASE_NAME) {
    throw new UnsafeIntegrationEnvError(
      `DATABASE_URL aponta para o banco "${databaseName}" em vez de "${TEST_DATABASE_NAME}"`,
    );
  }
  if (!LOCAL_HOSTS.has(database.hostname)) {
    throw new UnsafeIntegrationEnvError('DATABASE_URL não aponta para localhost');
  }

  const redisIndex = redis.pathname.replace(/^\//, '');
  if (redisIndex !== String(TEST_REDIS_DB_INDEX)) {
    throw new UnsafeIntegrationEnvError(
      `REDIS_URL usa o índice "${redisIndex === '' ? '0' : redisIndex}" em vez de ${String(TEST_REDIS_DB_INDEX)}`,
    );
  }
  if (!LOCAL_HOSTS.has(redis.hostname)) {
    throw new UnsafeIntegrationEnvError('REDIS_URL não aponta para localhost');
  }
}

/**
 * Config dos testes de integração, lida do ambiente (`.env.test` ou variáveis do CI).
 * Chamada no topo de cada arquivo de integração: se o ambiente for inseguro, o arquivo
 * inteiro falha antes de abrir qualquer conexão.
 */
export function loadIntegrationConfig(env: NodeJS.ProcessEnv = process.env): Config {
  assertSafeIntegrationEnv(env);
  const parsed = parseConfig({ ...env, NODE_ENV: 'test', LOG_LEVEL: 'silent' });
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}
