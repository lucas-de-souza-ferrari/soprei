import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getClosedPort } from './test-support/closed-port.js';

const ENTRYPOINT = fileURLToPath(new URL('./index.ts', import.meta.url));
const TSX = import.meta.resolve('tsx');

// Roda em um diretório vazio para que nenhum .env do desenvolvedor interfira.
let emptyDir: string;

before(() => {
  emptyDir = mkdtempSync(join(tmpdir(), 'soprei-boot-'));
});

after(() => {
  rmSync(emptyDir, { recursive: true, force: true });
});

function bootEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const { PATH, Path, SystemRoot } = process.env;
  return { PATH, Path, SystemRoot, ...extra };
}

function boot(extra: Record<string, string>): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, ['--import', TSX, ENTRYPOINT], {
    cwd: emptyDir,
    env: bootEnv(extra),
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('boot da aplicação (sem infraestrutura)', () => {
  it('encerra com código 1 e mensagem clara quando DATABASE_URL está ausente', () => {
    const { status, output } = boot({ REDIS_URL: 'redis://localhost:6379/0' });
    assert.equal(status, 1);
    assert.match(output, /Configuração inválida/);
    assert.match(output, /DATABASE_URL/);
    assert.match(output, /cp \.env\.example \.env/);
  });

  it('encerra com código 1 e mensagem clara quando REDIS_URL está ausente', () => {
    const { status, output } = boot({ DATABASE_URL: 'postgresql://u:p@localhost:5432/db' });
    assert.equal(status, 1);
    assert.match(output, /Configuração inválida/);
    assert.match(output, /REDIS_URL/);
    assert.match(output, /obrigatória ausente/);
  });

  it('encerra com código 1 e nomeia o banco e o Redis quando ambos estão indisponíveis', async () => {
    const [dbPort, redisPort] = [await getClosedPort(), await getClosedPort()];
    const { status, output } = boot({
      NODE_ENV: 'production',
      DATABASE_URL: `postgresql://u:p@127.0.0.1:${String(dbPort)}/db`,
      REDIS_URL: `redis://127.0.0.1:${String(redisPort)}/0`,
      DB_POOL_CONNECTION_TIMEOUT_MS: '1000',
    });
    assert.equal(status, 1);
    assert.match(output, /dependência indisponível no boot: PostgreSQL, Redis/);
  });
});
