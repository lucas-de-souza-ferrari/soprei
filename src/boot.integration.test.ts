import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRedis } from './infrastructure/cache/redis.client.js';
import { createLogger } from './infrastructure/logger/logger.js';
import { getClosedPort, withPort } from './test-support/closed-port.js';
import { loadIntegrationConfig } from './test-support/integration-env.js';

// Falha aqui (antes de subir qualquer processo) se o ambiente não for o de testes.
const config = loadIntegrationConfig();

const ENTRYPOINT = fileURLToPath(new URL('./index.ts', import.meta.url));
const TSX = import.meta.resolve('tsx');

// Roda em um diretório vazio para que nenhum .env do desenvolvedor interfira.
let emptyDir: string;

before(() => {
  emptyDir = mkdtempSync(join(tmpdir(), 'soprei-boot-int-'));
});

after(() => {
  rmSync(emptyDir, { recursive: true, force: true });
});

function bootEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const { PATH, Path, SystemRoot } = process.env;
  return {
    PATH,
    Path,
    SystemRoot,
    NODE_ENV: 'production',
    // Em produção a chave de administração é obrigatória (valor descartável, só do teste).
    ADMIN_API_KEY: 'k'.repeat(32),
    HOST: '127.0.0.1',
    PORT: '0',
    DATABASE_URL: config.DATABASE_URL,
    REDIS_URL: config.REDIS_URL,
    DB_POOL_CONNECTION_TIMEOUT_MS: '1000',
    ...extra,
  };
}

describe('boot com um serviço indisponível', () => {
  it('sai com código 1 e cita só o Redis quando o Redis está fora', async () => {
    const result = spawnSync(process.execPath, ['--import', TSX, ENTRYPOINT], {
      cwd: emptyDir,
      env: bootEnv({ REDIS_URL: withPort(config.REDIS_URL, await getClosedPort()) }),
      encoding: 'utf8',
      timeout: 60_000,
    });
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 1);
    assert.match(output, /dependência indisponível no boot: Redis"/);
    assert.ok(!output.includes('PostgreSQL indisponível'));
  });

  it('sai com código 1 e cita só o PostgreSQL quando o banco está fora', async () => {
    const result = spawnSync(process.execPath, ['--import', TSX, ENTRYPOINT], {
      cwd: emptyDir,
      env: bootEnv({ DATABASE_URL: withPort(config.DATABASE_URL, await getClosedPort()) }),
      encoding: 'utf8',
      timeout: 60_000,
    });
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 1);
    assert.match(output, /dependência indisponível no boot: PostgreSQL"/);
    assert.ok(!output.includes('Redis indisponível'));
  });
});

describe('boot com infraestrutura no ar', () => {
  it('loga o erro e encerra com código 1 quando a porta está em uso', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    assert.ok(address !== null && typeof address === 'object');

    try {
      const result = spawnSync(process.execPath, ['--import', TSX, ENTRYPOINT], {
        cwd: emptyDir,
        env: bootEnv({ PORT: String(address.port) }),
        encoding: 'utf8',
        timeout: 60_000,
      });
      const output = `${result.stdout}${result.stderr}`;
      assert.equal(result.status, 1);
      assert.match(output, /EADDRINUSE/);
      assert.match(output, /falha ao iniciar o servidor/);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it('sobe, responde /health e /health/ready com 200 e encerra', async () => {
    const child = spawn(process.execPath, ['--import', TSX, ENTRYPOINT], {
      cwd: emptyDir,
      env: bootEnv({}),
    });
    let output = '';
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`servidor não subiu a tempo. Saída: ${output}`));
      }, 30_000);
      const onData = (chunk: Buffer): void => {
        output += chunk.toString();
        const match = /Server listening at http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
        if (match?.[1] !== undefined) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`processo saiu com código ${String(code)}. Saída: ${output}`));
      });
    });

    try {
      const live = await fetch(`http://127.0.0.1:${String(port)}/health`);
      assert.equal(live.status, 200);
      const ready = await fetch(`http://127.0.0.1:${String(port)}/health/ready`);
      assert.equal(ready.status, 200);
      assert.deepEqual(await ready.json(), {
        status: 'ok',
        checks: { database: 'up', redis: 'up' },
      });
    } finally {
      child.removeAllListeners('exit');
      const exited = new Promise<void>((resolve) =>
        child.once('exit', () => {
          resolve();
        }),
      );
      child.kill();
      await exited;
    }
  });
});

interface RunningServer {
  readonly port: number;
  output(): string;
  stop(): Promise<void>;
}

/** Sobe `src/index.ts` como processo e espera a linha de "listening". */
async function startServer(extra: Record<string, string>): Promise<RunningServer> {
  const child = spawn(process.execPath, ['--import', TSX, ENTRYPOINT], {
    cwd: emptyDir,
    env: bootEnv(extra),
  });
  let output = '';
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`servidor não subiu a tempo. Saída: ${output}`));
    }, 30_000);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const match = /Server listening at http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`processo saiu com código ${String(code)}. Saída: ${output}`));
    });
  });
  return {
    port,
    output: () => output,
    async stop() {
      child.removeAllListeners('exit');
      const exited = new Promise<void>((resolve) =>
        child.once('exit', () => {
          resolve();
        }),
      );
      child.kill();
      await exited;
    },
  };
}

describe('boot com rate limiting (spec 005)', () => {
  it('liga o limite por IP de ponta a ponta, com TRUST_PROXY=1 e o Redis dedicado', async () => {
    // IPv6 aleatório (documentação, 2001:db8::/32) de /64 próprio: a chave do contador no Redis
    // é só deste teste (`soprei:ratelimit:admin:2001:db8:xxxx:yyyy::`) e expira em 5 s.
    const a = randomBytes(2).toString('hex');
    const b = randomBytes(2).toString('hex');
    const clientIp = `2001:db8:${a}:${b}::1`;
    const server = await startServer({
      TRUST_PROXY: '1',
      RATE_LIMIT_ADMIN_MAX: '2',
      RATE_LIMIT_ADMIN_WINDOW_SECONDS: '5',
    });
    const redis = createRedis(config, createLogger(config));
    try {
      const url = `http://127.0.0.1:${String(server.port)}/admin/clients`;
      // O "proxy" (o próprio fetch, em 127.0.0.1) acrescenta o IP do cliente ao fim; o começo é forjado.
      const headers = { 'x-forwarded-for': `203.0.113.250, ${clientIp}` };
      const statuses: number[] = [];
      let last: Response | undefined;
      for (let i = 0; i < 3; i += 1) {
        last = await fetch(url, { headers });
        statuses.push(last.status);
      }
      assert.deepEqual(statuses, [401, 401, 429]);
      assert.equal(last?.headers.get('retry-after') !== null, true);
      const body = (await last?.json()) as { error: { code: string; retryAfter: number } };
      assert.equal(body.error.code, 'RATE_LIMITED');
      assert.ok(Number.isInteger(body.error.retryAfter) && body.error.retryAfter >= 1);

      // Outro IP (outro /64) não foi afetado.
      const other = await fetch(url, { headers: { 'x-forwarded-for': '198.51.100.9' } });
      assert.equal(other.status, 401);

      // /health segue fora do limite.
      assert.equal((await fetch(`http://127.0.0.1:${String(server.port)}/health`)).status, 200);

      // Só a chave deste teste (nome exato, derivado do IP aleatório) é removida.
      const keys = [
        `soprei:ratelimit:admin:2001:db8:${a}:${b}::`,
        'soprei:ratelimit:admin:198.51.100.9',
      ];
      assert.equal(await redis.client.exists(keys[0] ?? ''), 1);
      await redis.client.del(...keys);
    } finally {
      await server.stop();
      await redis.close();
    }
  });

  it('com RATE_LIMIT_ENABLED=false (fora de produção) não limita e avisa no log', async () => {
    const server = await startServer({
      NODE_ENV: 'development',
      RATE_LIMIT_ENABLED: 'false',
      RATE_LIMIT_ADMIN_MAX: '1',
    });
    try {
      const url = `http://127.0.0.1:${String(server.port)}/admin/clients`;
      for (let i = 0; i < 4; i += 1) {
        assert.equal((await fetch(url)).status, 401);
      }
      assert.match(server.output(), /rate limiting desligado/);
    } finally {
      await server.stop();
    }
  });

  it('RATE_LIMIT_ENABLED=false em produção derruba o boot com código 1', () => {
    const result = spawnSync(process.execPath, ['--import', TSX, ENTRYPOINT], {
      cwd: emptyDir,
      env: bootEnv({ RATE_LIMIT_ENABLED: 'false' }),
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}${result.stderr}`, /RATE_LIMIT_ENABLED/);
  });
});
