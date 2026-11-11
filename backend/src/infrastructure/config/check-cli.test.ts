import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkConfig, issueName } from './check-cli.js';

// `config:check` (spec 037, D12): valida o `.env` com o mesmo schema do boot, sem conectar a nada e
// sem imprimir valor. O teste roda o programa de verdade, num diretório vazio, sem Postgres nem Redis.
const ENTRYPOINT = fileURLToPath(new URL('./check-cli.ts', import.meta.url));
const TSX = import.meta.resolve('tsx');

// Valor que, se aparecesse na saída, provaria o vazamento.
const SECRET_SENTINEL = 'SENTINELA-SEGREDO-NAO-PODE-APARECER';

let workDir: string;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'soprei-config-check-'));
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function run(envFile: string | undefined, extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(workDir, 'case-'));
  if (envFile !== undefined) {
    writeFileSync(join(dir, '.env'), envFile);
  }
  const { PATH, Path, SystemRoot } = process.env;
  const result = spawnSync(process.execPath, ['--import', TSX, ENTRYPOINT], {
    cwd: dir,
    env: { PATH, Path, SystemRoot, ...extraEnv },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const VALID_DOTENV = [
  'DATABASE_URL=postgresql://u:p@127.0.0.1:1/db',
  'REDIS_URL=redis://127.0.0.1:1/0',
  `JWT_SECRET=${'j'.repeat(40)}`,
  '',
].join('\n');

describe('config:check', () => {
  it('com .env válido sai com 0 e imprime só "ok" (sem Postgres nem Redis no ar)', () => {
    const result = run(VALID_DOTENV);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'ok');
    assert.equal(result.stderr, '');
  });

  it('com variável inválida sai com 1 e imprime só o nome, nunca o valor', () => {
    const result = run(
      [
        `DATABASE_URL=${SECRET_SENTINEL}`,
        'REDIS_URL=redis://127.0.0.1:1/0',
        `JWT_SECRET=${'j'.repeat(40)}`,
        '',
      ].join('\n'),
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout.trim(), 'DATABASE_URL');
    assert.ok(!`${result.stdout}${result.stderr}`.includes(SECRET_SENTINEL));
  });

  it('com variável ausente sai com 1 e lista só os nomes que faltam', () => {
    const result = run('LOG_LEVEL=info\n');
    assert.equal(result.status, 1);
    const names = result.stdout.trim().split('\n');
    assert.ok(names.includes('DATABASE_URL'));
    assert.ok(names.includes('JWT_SECRET'));
    for (const name of names) {
      assert.match(name, /^[A-Za-z0-9_.()ãçõ ]+$/);
      assert.ok(!name.includes(':'));
    }
  });

  it('valor inválido de um segredo conhecido não aparece na saída (mensagem do Zod não é impressa)', () => {
    const result = run(VALID_DOTENV, { JWT_SECRET: SECRET_SENTINEL.slice(0, 10) });
    assert.equal(result.status, 1);
    assert.equal(result.stdout.trim(), 'JWT_SECRET');
    assert.ok(!`${result.stdout}${result.stderr}`.includes(SECRET_SENTINEL.slice(0, 10)));
  });

  it('regra cruzada de produção também é pega (o mesmo schema do boot)', () => {
    const result = run(`${VALID_DOTENV}NODE_ENV=production\nRATE_LIMIT_ENABLED=false\n`);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /RATE_LIMIT_ENABLED/);
  });
});

describe('checkConfig e issueName (puras)', () => {
  it('issueName usa só a parte antes do primeiro ":" e recusa nome com caracteres estranhos', () => {
    assert.equal(issueName('DATABASE_URL: Invalid input'), 'DATABASE_URL');
    assert.equal(issueName('a.b: x'), 'a.b');
    assert.equal(issueName('valor secreto sem dois pontos'), '(configuração)');
    assert.equal(issueName(': vazio'), '(configuração)');
  });

  it('checkConfig devolve ok para ambiente válido e os nomes (sem repetição) para inválido', () => {
    assert.deepEqual(
      checkConfig({
        DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
        REDIS_URL: 'redis://localhost:6379/0',
        JWT_SECRET: 'j'.repeat(32),
      }),
      { exitCode: 0, lines: ['ok'] },
    );
    const bad = checkConfig({});
    assert.equal(bad.exitCode, 1);
    assert.equal(new Set(bad.lines).size, bad.lines.length);
  });
});
