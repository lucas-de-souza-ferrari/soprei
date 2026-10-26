import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertSafeIntegrationEnv,
  loadIntegrationConfig,
  UnsafeIntegrationEnvError,
} from './integration-env.js';

const SAFE = {
  DATABASE_URL: 'postgresql://soprei:segredo@localhost:5432/soprei_test?schema=public',
  REDIS_URL: 'redis://localhost:6379/15',
};

function withOverrides(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return { ...SAFE, ...overrides };
}

describe('trava de segurança dos testes de integração', () => {
  it('aceita soprei_test e Redis /15 em localhost', () => {
    assert.doesNotThrow(() => {
      assertSafeIntegrationEnv(SAFE);
    });
    assert.doesNotThrow(() => {
      assertSafeIntegrationEnv(
        withOverrides({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/soprei_test' }),
      );
    });
  });

  const refusals: readonly (readonly [string, Record<string, string>])[] = [
    [
      'banco de desenvolvimento',
      { DATABASE_URL: 'postgresql://soprei:segredo@localhost:5432/soprei' },
    ],
    ['banco qualquer', { DATABASE_URL: 'postgresql://soprei:segredo@localhost:5432/postgres' }],
    ['banco sem nome', { DATABASE_URL: 'postgresql://soprei:segredo@localhost:5432' }],
    [
      'host remoto no banco',
      { DATABASE_URL: 'postgresql://soprei:segredo@db.example.com:5432/soprei_test' },
    ],
    ['Redis /0', { REDIS_URL: 'redis://localhost:6379/0' }],
    ['Redis sem índice', { REDIS_URL: 'redis://localhost:6379' }],
    ['host remoto no Redis', { REDIS_URL: 'redis://cache.example.com:6379/15' }],
  ];
  for (const [name, overrides] of refusals) {
    it(`recusa rodar: ${name}`, () => {
      assert.throws(
        () => {
          assertSafeIntegrationEnv(withOverrides(overrides));
        },
        (error: unknown) => {
          assert.ok(error instanceof UnsafeIntegrationEnvError);
          assert.match(error.message, /Testes de integração recusados/);
          // A senha nunca aparece na mensagem.
          assert.ok(!error.message.includes('segredo'));
          return true;
        },
      );
    });
  }

  it('recusa quando as variáveis estão ausentes ou inválidas', () => {
    assert.throws(() => {
      assertSafeIntegrationEnv({});
    }, UnsafeIntegrationEnvError);
    assert.throws(() => {
      assertSafeIntegrationEnv(withOverrides({ DATABASE_URL: 'não é url' }));
    }, UnsafeIntegrationEnvError);
  });

  it('loadIntegrationConfig valida o ambiente e força NODE_ENV=test e log silencioso', () => {
    const config = loadIntegrationConfig(SAFE);
    assert.equal(config.NODE_ENV, 'test');
    assert.equal(config.LOG_LEVEL, 'silent');
    assert.throws(() =>
      loadIntegrationConfig(withOverrides({ REDIS_URL: 'redis://localhost:6379/0' })),
    );
  });
});

describe('segurança do Redis compartilhado', () => {
  it('nenhum código do projeto emite o comando que apaga o banco inteiro', () => {
    // Montado em pedaços para este arquivo não casar consigo mesmo.
    const forbidden = new RegExp(['FLUSH', '(ALL|DB)'].join(''), 'i');
    const root = fileURLToPath(new URL('..', import.meta.url));
    const offenders: string[] = [];

    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'generated') visit(path);
        } else if (entry.name.endsWith('.ts') && forbidden.test(readFileSync(path, 'utf8'))) {
          offenders.push(path);
        }
      }
    };
    visit(root);

    assert.deepEqual(offenders, []);
  });
});
