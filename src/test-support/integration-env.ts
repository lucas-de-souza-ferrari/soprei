import { type Config, parseConfig } from '../infrastructure/config/index.js';
import { TEST_JWT_SECRET } from './in-memory-auth.js';

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
  // `JWT_SECRET` é obrigatória (spec 007); os testes não dependem de o `.env.test` a ter e usam um
  // valor descartável, que nunca vale fora dos testes.
  const jwtSecret =
    env.JWT_SECRET === undefined || env.JWT_SECRET === '' ? TEST_JWT_SECRET : env.JWT_SECRET;
  // Credenciais por cliente (spec 015): se o `.env.test` não as tem, chaves e app id descartáveis
  // (nunca valem fora dos testes). Só importam com `WHATSAPP_ENABLED=true`.
  const blank = (value: string | undefined): boolean => value === undefined || value === '';
  const parsed = parseConfig({
    ...env,
    ...(blank(env.CHANNEL_CREDENTIALS_KEYS)
      ? {
          CHANNEL_CREDENTIALS_KEYS: `teste:${'A'.repeat(43)}`,
          CHANNEL_CREDENTIALS_ACTIVE_KEY_ID: 'teste',
        }
      : {}),
    ...(blank(env.WHATSAPP_APP_ID) ? { WHATSAPP_APP_ID: '1234567890123' } : {}),
    JWT_SECRET: jwtSecret,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
  });
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}
