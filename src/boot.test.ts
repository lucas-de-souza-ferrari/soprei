import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

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

describe('boot da aplicação', () => {
  it('encerra com código 1 e mensagem clara quando DATABASE_URL está ausente', () => {
    const result = spawnSync(process.execPath, ['--import', TSX, ENTRYPOINT], {
      cwd: emptyDir,
      env: bootEnv({}),
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Configuração inválida/);
    assert.match(result.stderr, /DATABASE_URL/);
    assert.match(result.stderr, /cp \.env\.example \.env/);
  });

  it('loga o erro e encerra com código 1 quando a porta está em uso', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    assert.ok(address !== null && typeof address === 'object');

    try {
      const child = spawn(process.execPath, ['--import', TSX, ENTRYPOINT], {
        cwd: emptyDir,
        env: bootEnv({
          NODE_ENV: 'production',
          HOST: '127.0.0.1',
          PORT: String(address.port),
          DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
        }),
      });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      const code = await new Promise<number | null>((resolve) => child.on('close', resolve));

      assert.equal(code, 1);
      assert.match(output, /EADDRINUSE/);
      assert.match(output, /falha ao iniciar o servidor/);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });
});
